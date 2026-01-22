import { IssuePriorityValue, User } from "@linear/sdk";
import {
  List,
  ActionPanel,
  Action,
  Icon,
  showToast,
  Toast,
  getPreferenceValues,
  Keyboard,
  Color,
  openCommandPreferences,
  Clipboard,
  open,
  getApplications,
} from "@raycast/api";
import { format } from "date-fns";
import { useState, useCallback, useMemo } from "react";

import { createIssue, type CreateIssuePayload } from "../api/createIssue";
import { getDateIcon } from "../helpers/dates";
import { parseQuickIssue, getPriorityLabel, type ParsedQuickIssue, type LinearData } from "../helpers/parseQuickIssue";
import { priorityIcons } from "../helpers/priorities";
import useLabels from "../hooks/useLabels";
import useProjects from "../hooks/useProjects";
import useTeams from "../hooks/useTeams";
import useUsers from "../hooks/useUsers";

import CreateIssueForm from "./CreateIssueForm";

interface QuickIssueFormProps {
  priorities: IssuePriorityValue[] | undefined;
  me: User | undefined;
  isLoading?: boolean;
}

interface Preferences {
  defaultTeamId?: string;
  autoAssignToSelf?: boolean;
}

export default function QuickIssueForm({ priorities, me, isLoading: propsLoading }: QuickIssueFormProps) {
  const [searchText, setSearchText] = useState("");
  const [parsedIssue, setParsedIssue] = useState<ParsedQuickIssue | null>(null);
  const preferences = getPreferenceValues<Preferences>();

  // Fetch data for fuzzy matching
  const { teams, isLoadingTeams } = useTeams();
  const defaultTeam = useMemo(() => {
    if (!teams) return undefined;
    if (preferences.defaultTeamId) {
      return teams.find((t) => t.id === preferences.defaultTeamId || t.key === preferences.defaultTeamId);
    }
    return teams[0];
  }, [teams, preferences.defaultTeamId]);

  const selectedTeamId = parsedIssue?.team?.id ?? defaultTeam?.id;
  const { labels, isLoadingLabels } = useLabels(selectedTeamId, { execute: !!selectedTeamId });
  const { users, isLoadingUsers } = useUsers();
  const { projects, isLoadingProjects } = useProjects(selectedTeamId, { execute: !!selectedTeamId });

  const isLoading = propsLoading || isLoadingTeams || isLoadingLabels || isLoadingUsers || isLoadingProjects;

  const linearData: LinearData = useMemo(
    () => ({
      teams: teams ?? [],
      projects: projects ?? [],
      labels: labels ?? [],
      users: users ?? [],
    }),
    [teams, projects, labels, users],
  );

  const handleSearchTextChange = useCallback(
    (text: string) => {
      setSearchText(text);
      if (text.trim().length > 0) {
        const parsed = parseQuickIssue(text, linearData);
        setParsedIssue(parsed);
      } else {
        setParsedIssue(null);
      }
    },
    [linearData],
  );

  const handleCreateIssue = useCallback(async () => {
    if (!parsedIssue || parsedIssue.hasErrors || !parsedIssue.title.trim()) {
      showToast({
        style: Toast.Style.Failure,
        title: "Cannot create issue",
        message: parsedIssue?.hasErrors ? "Fix validation errors first" : "Title is required",
      });
      return;
    }

    const teamId = parsedIssue.team?.id ?? defaultTeam?.id;
    if (!teamId) {
      showToast({
        style: Toast.Style.Failure,
        title: "Team required",
        message: "Please set a default team in preferences or specify with /team",
      });
      return;
    }

    // Determine assignee: explicit @mention > auto-assign to self > none
    let assigneeId = parsedIssue.assignee?.id;
    if (!assigneeId && preferences.autoAssignToSelf && me?.id) {
      assigneeId = me.id;
    }

    const payload: CreateIssuePayload = {
      title: parsedIssue.title,
      description: parsedIssue.description || "",
      teamId,
      priority: parsedIssue.priority?.value ?? 0,
      dueDate: parsedIssue.dueDate?.value ?? null,
      labelIds: parsedIssue.labels.filter((l) => l.matched && l.id).map((l) => l.id!),
      assigneeId,
      projectId: parsedIssue.project?.id,
      estimate: typeof parsedIssue.estimate?.value === "number" ? parsedIssue.estimate.value : undefined,
    };

    try {
      const toast = await showToast({ style: Toast.Style.Animated, title: "Creating issue..." });
      const result = await createIssue(payload);

      if (result.success && result.issue) {
        toast.style = Toast.Style.Success;
        toast.title = `Created ${result.issue.identifier}`;
        toast.message = parsedIssue.title;
        const issueUrl = result.issue.url;
        toast.primaryAction = {
          title: "Open in Linear",
          onAction: async () => {
            const applications = await getApplications();
            const linearApp = applications.find((app) => app.bundleId === "com.linear");
            open(issueUrl, linearApp);
          },
        };
        toast.secondaryAction = {
          title: "Copy Issue URL",
          onAction: () => {
            Clipboard.copy(issueUrl);
          },
        };
        setSearchText("");
        setParsedIssue(null);
      } else {
        toast.style = Toast.Style.Failure;
        toast.title = "Failed to create issue";
      }
    } catch (error) {
      showToast({
        style: Toast.Style.Failure,
        title: "Error creating issue",
        message: String(error),
      });
    }
  }, [parsedIssue, defaultTeam, preferences.autoAssignToSelf, me]);

  const getSubtitle = useCallback(() => {
    if (!parsedIssue) return "";

    // Format: "due date → team · description" (like quick-event)
    const metaParts: string[] = [];

    // Due date first
    if (parsedIssue.dueDate?.matched && parsedIssue.dueDate.value) {
      metaParts.push(format(parsedIssue.dueDate.value, "MMM d"));
    }

    // Team with arrow separator
    const teamName = parsedIssue.team?.value ?? defaultTeam?.name;
    const dateAndTeam = metaParts.length > 0 && teamName ? `${metaParts.join("")} → ${teamName}` : teamName || "";

    // Description after dot separator
    if (parsedIssue.description) {
      return dateAndTeam ? `${dateAndTeam} · ${parsedIssue.description}` : parsedIssue.description;
    }

    return dateAndTeam;
  }, [parsedIssue, defaultTeam]);

  const getAccessories = useCallback((): List.Item.Accessory[] => {
    if (!parsedIssue) return [];

    const accessories: List.Item.Accessory[] = [];
    const errors: List.Item.Accessory[] = [];

    // Due date with calendar icon (like IssueListItem)
    if (parsedIssue.dueDate?.matched && parsedIssue.dueDate.value) {
      accessories.push({
        icon: getDateIcon(parsedIssue.dueDate.value),
        tooltip: `Due: ${format(parsedIssue.dueDate.value, "EEEE, MMM d, yyyy")}`,
      });
    }

    // Labels with tag icon
    const matchedLabels = parsedIssue.labels.filter((l) => l.matched);
    if (matchedLabels.length > 0) {
      accessories.push({
        icon: Icon.Tag,
        text: matchedLabels.length > 1 ? String(matchedLabels.length) : undefined,
        tooltip: matchedLabels.map((l) => l.value).join(", "),
      });
    }

    // Project with box icon
    if (parsedIssue.project?.matched) {
      accessories.push({
        icon: { source: Icon.Folder, tintColor: Color.Purple },
        tooltip: `Project: ${parsedIssue.project.value}`,
      });
    }

    // Estimate with gauge icon
    if (parsedIssue.estimate?.matched) {
      accessories.push({
        icon: { source: { light: "light/estimate.svg", dark: "dark/estimate.svg" } },
        text: String(parsedIssue.estimate.value),
        tooltip: `Estimate: ${parsedIssue.estimate.value}`,
      });
    }

    // Priority with icon (already shown as main icon, but add tooltip)
    if (parsedIssue.priority?.matched && parsedIssue.priority.value !== undefined) {
      accessories.push({
        icon: { source: priorityIcons[parsedIssue.priority.value] },
        tooltip: `Priority: ${getPriorityLabel(parsedIssue.priority.value)}`,
      });
    }

    // Assignee with person icon
    if (parsedIssue.assignee?.matched) {
      accessories.push({
        icon: Icon.Person,
        tooltip: `Assignee: ${parsedIssue.assignee.value}`,
      });
    }

    // Collect errors (shown as red tags at the end)
    for (const label of parsedIssue.labels.filter((l) => !l.matched)) {
      errors.push({ tag: { value: `*${label.rawToken}`, color: Color.Red } });
    }
    if (parsedIssue.assignee && !parsedIssue.assignee.matched) {
      errors.push({ tag: { value: `@${parsedIssue.assignee.rawToken}`, color: Color.Red } });
    }
    if (parsedIssue.project && !parsedIssue.project.matched) {
      errors.push({ tag: { value: `#${parsedIssue.project.rawToken}`, color: Color.Red } });
    }
    if (parsedIssue.team && !parsedIssue.team.matched) {
      errors.push({ tag: { value: `/${parsedIssue.team.rawToken}`, color: Color.Red } });
    }
    if (parsedIssue.dueDate && !parsedIssue.dueDate.matched) {
      errors.push({ tag: { value: `<${parsedIssue.dueDate.rawToken}`, color: Color.Red } });
    }
    if (parsedIssue.priority && !parsedIssue.priority.matched) {
      errors.push({ tag: { value: `!${parsedIssue.priority.rawToken}`, color: Color.Red } });
    }

    return [...accessories, ...errors];
  }, [parsedIssue]);

  const canCreate = parsedIssue && !parsedIssue.hasErrors && parsedIssue.title.trim().length > 0;

  // Check if default team is configured
  if (!isLoading && !defaultTeam) {
    return (
      <List>
        <List.EmptyView
          title="No Default Team Configured"
          description="Please set a default team in the extension preferences"
          actions={
            <ActionPanel>
              <Action title="Open Preferences" icon={Icon.Gear} onAction={openCommandPreferences} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={handleSearchTextChange}
      searchBarPlaceholder="Fix login bug /eng #mobile *bug @alex !1 <friday"
    >
      {parsedIssue && parsedIssue.title.trim().length > 0 ? (
        <>
          <List.Section title="Your quick issue">
            <List.Item
              title={parsedIssue.title || "Untitled issue"}
              subtitle={getSubtitle()}
              icon={
                parsedIssue.hasErrors
                  ? { source: Icon.Warning, tintColor: Color.Red }
                  : {
                      source: priorityIcons[parsedIssue.priority?.value ?? 0],
                      tooltip: `Priority: ${getPriorityLabel(parsedIssue.priority?.value ?? 0)}`,
                    }
              }
              accessories={getAccessories()}
              actions={
                <ActionPanel>
                  <Action
                    title="Create Issue"
                    icon={Icon.Plus}
                    shortcut={{ modifiers: [], key: "return" } as Keyboard.Shortcut}
                    onAction={canCreate ? handleCreateIssue : undefined}
                  />
                  <Action.Push
                    title="Open Full Form"
                    icon={Icon.AppWindowSidebarRight}
                    shortcut={{ modifiers: ["cmd"], key: "return" }}
                    target={
                      <CreateIssueForm
                        priorities={priorities}
                        me={me}
                        teamId={parsedIssue.team?.id ?? defaultTeam?.id}
                        projectId={parsedIssue.project?.id}
                        assigneeId={parsedIssue.assignee?.id}
                        draftValues={{
                          teamId: parsedIssue.team?.id ?? defaultTeam?.id ?? "",
                          title: parsedIssue.title,
                          description: parsedIssue.description || "",
                          stateId: "",
                          priority: String(parsedIssue.priority?.value ?? 0),
                          assigneeId: parsedIssue.assignee?.id ?? "",
                          labelIds: parsedIssue.labels.filter((l) => l.matched && l.id).map((l) => l.id!),
                          estimate: parsedIssue.estimate?.value ? String(parsedIssue.estimate.value) : "",
                          dueDate: parsedIssue.dueDate?.value ?? null,
                          cycleId: "",
                          projectId: parsedIssue.project?.id ?? "",
                          milestoneId: "",
                          parentId: "",
                          attachments: [],
                          links: "",
                        }}
                      />
                    }
                  />
                </ActionPanel>
              }
            />
          </List.Section>
          <List.Section title="Syntax guide">
            <List.Item
              title="/team  #project  *label  @assignee  !priority  <deadline  // description"
              icon={{ source: Icon.Info, tintColor: Color.SecondaryText }}
              accessories={[{ text: "⏎ to create", tooltip: "Press Enter to create issue" }]}
            />
          </List.Section>
        </>
      ) : (
        <List.EmptyView
          title="Create a Quick Issue"
          description={`Type your issue with optional metadata:\n\n/team  #project  *label  @assignee  !priority  <deadline  // description\n\nExample: Fix login bug /eng *bug !1 <friday // Users can't log in with SSO`}
        />
      )}
    </List>
  );
}
