import path from "path";

import { Action, ActionPanel, Grid, Icon, useNavigation } from "@raycast/api";
import { usePromise } from "@raycast/utils";
import { formatDistanceToNow } from "date-fns";

import { findRecentScreenshots, resolveScreenshotDirectory } from "../helpers/quickIssueAttachments";

type RecentScreenshotsGridProps = {
  directoryPreference: string | undefined;
  onSelect: (filePaths: string[]) => void;
};

export default function RecentScreenshotsGrid({ directoryPreference, onSelect }: RecentScreenshotsGridProps) {
  const { pop } = useNavigation();
  const { data, isLoading, error } = usePromise(
    async (preference: string | undefined) => {
      const directory = await resolveScreenshotDirectory(preference);
      return { directory, screenshots: await findRecentScreenshots(directory, 30) };
    },
    [directoryPreference],
  );

  return (
    <Grid isLoading={isLoading} columns={4} aspectRatio="16/9" fit={Grid.Fit.Fill} navigationTitle="Attach Screenshot">
      {error ? (
        <Grid.EmptyView icon={Icon.Warning} title="Can't read the screenshot folder" description={error.message} />
      ) : (
        <Grid.EmptyView icon={Icon.Image} title="No screenshots" description={data?.directory} />
      )}
      {data?.screenshots.map((screenshot) => (
        <Grid.Item
          key={screenshot.path}
          content={{ source: screenshot.path }}
          title={formatDistanceToNow(screenshot.modifiedAt, { addSuffix: true })}
          subtitle={path.basename(screenshot.path)}
          actions={
            <ActionPanel>
              <Action
                title="Attach Screenshot"
                icon={Icon.Paperclip}
                onAction={() => {
                  onSelect([screenshot.path]);
                  pop();
                }}
              />
              <Action.ToggleQuickLook shortcut={{ modifiers: ["cmd"], key: "y" }} />
              <Action.ShowInFinder path={screenshot.path} />
            </ActionPanel>
          }
          quickLook={{ path: screenshot.path }}
        />
      ))}
    </Grid>
  );
}
