import path from "path";
import { fileURLToPath } from "url";

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

import { uploadFile } from "../api/attachments";
import { createIssue, type CreateIssuePayload } from "../api/createIssue";
import { getDateIcon } from "../helpers/dates";
import { parseQuickIssue, getPriorityLabel, type ParsedQuickIssue, type LinearData } from "../helpers/parseQuickIssue";
import { priorityIcons } from "../helpers/priorities";
import {
  appendAttachmentsToDescription,
  findRecentScreenshots,
  isImagePath,
  resolveScreenshotDirectory,
  saveClipboardImage,
} from "../helpers/quickIssueAttachments";
import { getStatusIcon } from "../helpers/states";
import useLabels from "../hooks/useLabels";
import useProjects from "../hooks/useProjects";
import useStates from "../hooks/useStates";
import useTeams from "../hooks/useTeams";
import useUsers from "../hooks/useUsers";

import CreateIssueForm from "./CreateIssueForm";
import RecentScreenshotsGrid from "./RecentScreenshotsGrid";

interface QuickIssueFormProps {
  priorities: IssuePriorityValue[] | undefined;
  me: User | undefined;
  isLoading?: boolean;
}

interface Preferences {
  defaultTeamId?: string;
  autoAssignToSelf?: boolean;
  screenshotDirectory?: string;
}

export default function QuickIssueForm({ priorities, me, isLoading: propsLoading }: QuickIssueFormProps) {
  const [searchText, setSearchText] = useState("");
  const [parsedIssue, setParsedIssue] = useState<ParsedQuickIssue | null>(null);
  const [attachments, setAttachments] = useState<string[]>([]);
  const preferences = getPreferenceValues<Preferences>();

  const addAttachments = useCallback((filePaths: string[]) => {
    setAttachments((current) => [...current, ...filePaths.filter((filePath) => !current.includes(filePath))]);
  }, []);

  const removeAttachment = useCallback((filePath: string) => {
    setAttachments((current) => current.filter((existing) => existing !== filePath));
  }, []);

  const attachLatestScreenshot = useCallback(async () => {
    const directory = await resolveScreenshotDirectory(preferences.screenshotDirectory);
    try {
      const [latest] = await findRecentScreenshots(directory, 1);
      if (!latest) {
        await showToast({ style: Toast.Style.Failure, title: "No screenshots found", message: directory });
        return;
      }
      addAttachments([latest.path]);
      await showToast({
        style: Toast.Style.Success,
        title: "Attached screenshot",
        message: path.basename(latest.path),
      });
    } catch (error) {
      await showToast({ style: Toast.Style.Failure, title: "Can't read screenshot folder", message: String(error) });
    }
  }, [preferences.screenshotDirectory, addAttachments]);

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
  const { states, isLoadingStates } = useStates(selectedTeamId, { execute: !!selectedTeamId });

  const isLoading =
    propsLoading || isLoadingTeams || isLoadingLabels || isLoadingUsers || isLoadingProjects || isLoadingStates;

  const linearData: LinearData = useMemo(
    () => ({
      teams: teams ?? [],
      projects: projects ?? [],
      labels: labels ?? [],
      users: users ?? [],
      states: states ?? [],
    }),
    [teams, projects, labels, users, states],
  );

  const handleSearchTextChange = useCallback(
    (text: string) => {
      setSearchText(text);
      const trimmed = text.trim();
      setParsedIssue(trimmed ? parseQuickIssue(text, linearData) : null);
    },
    [linearData],
  );

  // Bound to ⌘V: a file or image on the clipboard becomes an attachment; plain text pastes into the search bar.
  const pasteFromClipboard = useCallback(async () => {
    const { file, text } = await Clipboard.read();
    if (!file && text) {
      handleSearchTextChange(searchText + text);
      return;
    }
    const filePath = file ? (file.startsWith("file://") ? fileURLToPath(file) : file) : await saveClipboardImage();
    if (!filePath) {
      await showToast({ style: Toast.Style.Failure, title: "Nothing to paste" });
      return;
    }
    addAttachments([filePath]);
    await showToast({ style: Toast.Style.Success, title: "Attached from clipboard", message: path.basename(filePath) });
  }, [searchText, handleSearchTextChange, addAttachments]);

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

    try {
      const toast = await showToast({
        style: Toast.Style.Animated,
        title: attachments.length > 0 ? "Uploading attachments..." : "Creating issue...",
      });

      let description = parsedIssue.description || "";
      if (attachments.length > 0) {
        const uploads = await Promise.all(attachments.map((filePath) => uploadFile(filePath)));
        if (uploads.some((upload) => !upload)) {
          throw new Error("Linear did not return an upload URL");
        }
        description = appendAttachmentsToDescription(
          description,
          uploads.filter((upload) => upload !== undefined),
        );
        toast.title = "Creating issue...";
      }

      const payload: CreateIssuePayload = {
        title: parsedIssue.title,
        description,
        teamId,
        priority: parsedIssue.priority?.value ?? 0,
        dueDate: parsedIssue.dueDate?.value ?? null,
        labelIds: parsedIssue.labels.filter((l) => l.matched && l.id).map((l) => l.id!),
        assigneeId,
        projectId: parsedIssue.project?.id,
        estimate: typeof parsedIssue.estimate?.value === "number" ? parsedIssue.estimate.value : undefined,
        stateId: parsedIssue.status?.id,
      };

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
        setAttachments([]);
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
  }, [parsedIssue, defaultTeam, preferences.autoAssignToSelf, me, attachments]);

  const getSubtitle = useCallback(() => {
    if (!parsedIssue) return "";

    const parts: string[] = [];

    // Due date first
    if (parsedIssue.dueDate?.matched && parsedIssue.dueDate.value) {
      parts.push(format(parsedIssue.dueDate.value, "MMM d"));
    }

    // Team with arrow separator
    const teamName = parsedIssue.team?.value ?? defaultTeam?.name;
    if (teamName) {
      parts.push(parts.length > 0 ? `→ ${teamName}` : teamName);
    }

    // Description after dot separator
    if (parsedIssue.description) {
      parts.push(parts.length > 0 ? `· ${parsedIssue.description}` : parsedIssue.description);
    }

    return parts.join(" ");
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

    // Status with state icon
    if (parsedIssue.status?.matched && parsedIssue.status.id) {
      const state = states?.find((s) => s.id === parsedIssue.status?.id);
      if (state) {
        accessories.push({
          icon: getStatusIcon(state),
          tooltip: `Status: ${parsedIssue.status.value}`,
        });
      }
    }

    // Collect errors (shown as red tags at the end)
    const unmatchedLabels = parsedIssue.labels.filter((l) => !l.matched);
    for (const label of unmatchedLabels) {
      errors.push({ tag: { value: `*${label.rawToken}`, color: Color.Red } });
    }

    const errorFields: Array<{ field: { matched: boolean; rawToken: string } | null; prefix: string }> = [
      { field: parsedIssue.assignee, prefix: "@" },
      { field: parsedIssue.project, prefix: "#" },
      { field: parsedIssue.team, prefix: "/" },
      { field: parsedIssue.dueDate, prefix: "<" },
      { field: parsedIssue.priority, prefix: "!" },
      { field: parsedIssue.status, prefix: "$" },
    ];

    for (const { field, prefix } of errorFields) {
      if (field && !field.matched) {
        errors.push({ tag: { value: `${prefix}${field.rawToken}`, color: Color.Red } });
      }
    }

    return [...accessories, ...errors];
  }, [parsedIssue, states]);

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

  const hasTitle = !!parsedIssue && parsedIssue.title.trim().length > 0;

  const createAction = (
    <Action
      title="Create Issue"
      icon={Icon.Plus}
      shortcut={{ modifiers: [], key: "return" } as Keyboard.Shortcut}
      onAction={canCreate ? handleCreateIssue : undefined}
    />
  );

  const attachActions = (
    <ActionPanel.Section title="Attach">
      <Action
        title="Attach Latest Screenshot"
        icon={Icon.Camera}
        shortcut={{ modifiers: ["cmd", "shift"], key: "s" }}
        onAction={attachLatestScreenshot}
      />
      <Action
        title="Paste Screenshot"
        icon={Icon.Clipboard}
        shortcut={{ modifiers: ["cmd"], key: "v" }}
        onAction={pasteFromClipboard}
      />
      <Action.Push
        title="Choose Screenshot"
        icon={Icon.Image}
        shortcut={{ modifiers: ["cmd", "shift"], key: "a" }}
        target={
          <RecentScreenshotsGrid directoryPreference={preferences.screenshotDirectory} onSelect={addAttachments} />
        }
      />
    </ActionPanel.Section>
  );

  const attachmentAccessory: List.Item.Accessory[] =
    attachments.length > 0
      ? [
          {
            icon: Icon.Paperclip,
            text: String(attachments.length),
            tooltip: attachments.map((a) => path.basename(a)).join(", "),
          },
        ]
      : [];

  return (
    <List
      isLoading={isLoading}
      searchText={searchText}
      onSearchTextChange={handleSearchTextChange}
      searchBarPlaceholder="Fix login bug /eng #mobile *bug @alex !1 <friday $in-progress"
    >
      {hasTitle && parsedIssue ? (
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
            accessories={[...attachmentAccessory, ...getAccessories()]}
            actions={
              <ActionPanel>
                {createAction}
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
                        stateId: parsedIssue.status?.id ?? "",
                        priority: String(parsedIssue.priority?.value ?? 0),
                        assigneeId: parsedIssue.assignee?.id ?? "",
                        labelIds: parsedIssue.labels.filter((l) => l.matched && l.id).map((l) => l.id!),
                        estimate: parsedIssue.estimate?.value ? String(parsedIssue.estimate.value) : "",
                        dueDate: parsedIssue.dueDate?.value ?? null,
                        cycleId: "",
                        projectId: parsedIssue.project?.id ?? "",
                        milestoneId: "",
                        parentId: "",
                        attachments,
                        links: "",
                      }}
                    />
                  }
                />
                {attachActions}
              </ActionPanel>
            }
          />
        </List.Section>
      ) : null}
      {attachments.length > 0 ? (
        <List.Section title="Attachments">
          {attachments.map((filePath) => (
            <List.Item
              key={filePath}
              title={path.basename(filePath)}
              icon={isImagePath(filePath) ? { source: filePath } : { fileIcon: filePath }}
              quickLook={{ path: filePath }}
              actions={
                <ActionPanel>
                  {hasTitle ? createAction : null}
                  <Action
                    title="Remove Attachment"
                    icon={Icon.Trash}
                    style={Action.Style.Destructive}
                    shortcut={{ modifiers: ["ctrl"], key: "x" }}
                    onAction={() => removeAttachment(filePath)}
                  />
                  <Action.ToggleQuickLook shortcut={{ modifiers: ["cmd"], key: "y" }} />
                  {attachActions}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      ) : null}
      {hasTitle ? (
        <List.Section title="Syntax guide">
          <List.Item
            title="/team  #project  *label  @assignee  !priority  <deadline  $status  // description"
            icon={{ source: Icon.Info, tintColor: Color.SecondaryText }}
            accessories={[{ text: "⏎ to create", tooltip: "Press Enter to create issue" }]}
          />
        </List.Section>
      ) : null}
      {!hasTitle && attachments.length === 0 ? (
        <List.EmptyView
          title="Create a Quick Issue"
          description={`Type your issue with optional metadata:\n\n/team  #project  *label  @assignee  !priority  <deadline  $status  // description\n\nExample: Fix login bug /eng *bug !1 <friday $in-progress // Users can't log in with SSO`}
          actions={<ActionPanel>{attachActions}</ActionPanel>}
        />
      ) : null}
    </List>
  );
}
