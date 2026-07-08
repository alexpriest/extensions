import { Action, ActionPanel, Icon, List, Toast, showToast, closeMainWindow, Keyboard } from "@raycast/api";
import { useMemo, useState } from "react";
import { format } from "date-fns";
import { useGoogleAPIs, withGoogleAPIs } from "./lib/google";
import useCalendars from "./hooks/useCalendars";
import {
  parseQuickEvent,
  formatEventDate,
  type EventType,
  type QuickEvent,
  type ParsedQuickEvent,
} from "./lib/parse-quick-event";

// ============= Main Component =============

function QuickCreateEvent() {
  const { calendar } = useGoogleAPIs();
  const { data: calendarsData, isLoading: isLoadingCalendars } = useCalendars();
  const [searchText, setSearchText] = useState("");
  const [isCreating, setIsCreating] = useState(false);

  // Get calendar names and ID mapping
  // Include calendars where user has write access (owner or writer)
  const calendars = useMemo(() => {
    const all = [...calendarsData.selected, ...calendarsData.unselected].filter(
      (cal) => cal.accessRole === "owner" || cal.accessRole === "writer",
    );
    return all.map((cal) => ({
      id: cal.primary ? "primary" : cal.id!,
      name: cal.summaryOverride ?? cal.summary ?? "Unknown",
      color: cal.backgroundColor ?? undefined,
    }));
  }, [calendarsData]);

  const calendarNames = useMemo(() => calendars.map((c) => c.name), [calendars]);

  // Parse the input
  const parsedEvent = useMemo(
    (): ParsedQuickEvent | null => parseQuickEvent(searchText, calendars, calendarNames),
    [searchText, calendarNames, calendars],
  );

  // Get ordered calendars (matched first)
  const orderedCalendars = useMemo(() => {
    if (!parsedEvent?.matchedCalendar) {
      return calendars;
    }
    const matched = calendars.find((c) => c.name === parsedEvent.matchedCalendar);
    if (!matched) return calendars;
    return [matched, ...calendars.filter((c) => c.id !== matched.id)];
  }, [calendars, parsedEvent?.matchedCalendar]);

  // Create event
  const createEvent = async (event: QuickEvent & { eventTypeLabel?: string }, calendarId: string) => {
    setIsCreating(true);
    try {
      const eventTypeLabels: Record<EventType, string> = {
        default: "Event",
        outOfOffice: "OOO",
        focusTime: "Focus Time",
      };
      const label = event.recurrence
        ? `Creating recurring ${eventTypeLabels[event.eventType].toLowerCase()}...`
        : `Creating ${eventTypeLabels[event.eventType]}...`;
      await showToast({ style: Toast.Style.Animated, title: label });

      // Build description from notes and URLs
      let fullDescription = event.description || "";
      if (event.urls && event.urls.length > 0) {
        if (fullDescription) fullDescription += "\n\n";
        fullDescription += event.urls.join("\n");
      }

      const baseBody = {
        summary:
          event.eventTitle ||
          (event.eventType === "outOfOffice"
            ? "Out of office"
            : event.eventType === "focusTime"
              ? "Focus time"
              : "Untitled event"),
        ...(event.eventType !== "default" && { eventType: event.eventType }),
        ...(event.recurrence && { recurrence: [event.recurrence] }),
        ...(event.location && { location: event.location }),
        ...(fullDescription && { description: fullDescription }),
        ...(event.showAs && { transparency: event.showAs === "free" ? "transparent" : "opaque" }),
        ...(event.attendees &&
          event.attendees.length > 0 && {
            attendees: event.attendees.map((email) => ({ email })),
          }),
        ...(event.alertMinutes !== undefined && {
          reminders: {
            useDefault: false,
            overrides: [{ method: "popup", minutes: event.alertMinutes }],
          },
        }),
      };

      // OOO and Focus Time events can't be all-day in Google Calendar API
      // Convert them to timed events spanning the full day(s)
      const needsTimedFormat = event.isAllDay && (event.eventType === "outOfOffice" || event.eventType === "focusTime");

      // Get local timezone - required for recurring events
      const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      let requestBody;
      if (needsTimedFormat) {
        // Convert all-day to timed: start at midnight, end at midnight of end date
        const startDateTime = new Date(event.startDate);
        startDateTime.setHours(0, 0, 0, 0);
        const endDateTime = new Date(event.endDate);
        endDateTime.setHours(0, 0, 0, 0);
        requestBody = {
          ...baseBody,
          start: { dateTime: startDateTime.toISOString(), timeZone: localTimeZone },
          end: { dateTime: endDateTime.toISOString(), timeZone: localTimeZone },
        };
      } else if (event.isAllDay) {
        requestBody = {
          ...baseBody,
          start: { date: format(event.startDate, "yyyy-MM-dd") },
          end: { date: format(event.endDate, "yyyy-MM-dd") },
        };
      } else {
        requestBody = {
          ...baseBody,
          start: { dateTime: event.startDate.toISOString(), timeZone: localTimeZone },
          end: { dateTime: event.endDate.toISOString(), timeZone: localTimeZone },
        };
      }

      await calendar.events.insert({
        calendarId,
        requestBody,
      });

      const successLabel = event.recurrence
        ? `Recurring ${eventTypeLabels[event.eventType].toLowerCase()} created!`
        : `${eventTypeLabels[event.eventType]} created!`;
      await showToast({ style: Toast.Style.Success, title: successLabel });
      await closeMainWindow({ clearRootSearch: true });
    } catch (error) {
      await showToast({
        style: Toast.Style.Failure,
        title: "Failed to create event",
        message: String(error),
      });
    } finally {
      setIsCreating(false);
    }
  };

  const getSubtitle = (event: QuickEvent & { eventTypeLabel?: string }) => {
    const parts: string[] = [];

    // Date/time
    parts.push(formatEventDate(event));

    // Calendar
    if (event.matchedCalendar) {
      parts[0] = `${parts[0]} → ${event.matchedCalendar}`;
    }

    // Notes indicator
    if (event.description) {
      const preview = event.description.length > 40 ? event.description.slice(0, 40) + "..." : event.description;
      parts.push(preview);
    }

    // URL count
    if (event.urls && event.urls.length > 0) {
      parts.push(`${event.urls.length} link${event.urls.length > 1 ? "s" : ""}`);
    }

    return parts.join(" · ");
  };

  const getIcon = (eventType: EventType) => {
    switch (eventType) {
      case "outOfOffice":
        return { source: Icon.AirplaneTakeoff, tintColor: "#F6BF27" };
      case "focusTime":
        return { source: Icon.BellDisabled, tintColor: "#7066FE" };
      default:
        return Icon.Calendar;
    }
  };

  return (
    <List
      isLoading={isLoadingCalendars || isCreating}
      onSearchTextChange={setSearchText}
      searchBarPlaceholder="E.g. meeting 2pm @(Conference Room) with john@email.com // Discuss Q1 goals"
      throttle
    >
      {!parsedEvent && (
        <List.EmptyView
          icon={Icon.Calendar}
          title="Create event with natural language"
          description='e.g. team standup tomorrow 9-9:30am @(location) with alex@company.com !15m every weekday ~busy /work // Daily sync'
          actions={
            <ActionPanel>
              <Action.OpenInBrowser
                title="View Documentation"
                icon={Icon.Book}
                url="https://github.com/raycast/extensions/tree/main/extensions/google-calendar"
              />
            </ActionPanel>
          }
        />
      )}
      {parsedEvent && (
        <List.Section title="Your quick event">
          <List.Item
            key={parsedEvent.id}
            title={
              parsedEvent.eventTitle ||
              (parsedEvent.eventType === "outOfOffice"
                ? "Out of office"
                : parsedEvent.eventType === "focusTime"
                  ? "Focus time"
                  : "Untitled event")
            }
            subtitle={getSubtitle(parsedEvent)}
            icon={getIcon(parsedEvent.eventType)}
            accessories={[
              ...(parsedEvent.apiLimitationWarning
                ? [
                    {
                      icon: Icon.Warning,
                      tag: { value: "API limit", color: "#AD1357" },
                      tooltip: parsedEvent.apiLimitationWarning,
                    },
                  ]
                : []),
              ...(parsedEvent.location
                ? [{ icon: Icon.Pin, tag: { value: parsedEvent.location, color: "#EF6D02" } }]
                : []),
              ...(parsedEvent.attendees && parsedEvent.attendees.length > 0
                ? [{ icon: Icon.AddPerson, tag: { value: `${parsedEvent.attendees.length}`, color: "#039BE5" } }]
                : []),
              ...(parsedEvent.alertMinutes !== undefined
                ? [
                    {
                      icon: Icon.AlarmRinging,
                      tag: {
                        value: `${parsedEvent.alertMinutes >= 60 ? `${parsedEvent.alertMinutes / 60}h` : `${parsedEvent.alertMinutes}m`}`,
                        color: "#D50201",
                      },
                    },
                  ]
                : []),
              ...(parsedEvent.showAs === "free" ? [{ tag: { value: "Free", color: "#7CB442" } }] : []),
              ...(parsedEvent.showAs === "busy" ? [{ tag: { value: "Busy", color: "#616161" } }] : []),
              ...(parsedEvent.recurrenceLabel
                ? [{ icon: Icon.Repeat, tag: { value: parsedEvent.recurrenceLabel, color: "#775547" } }]
                : []),
              ...(parsedEvent.eventTypeLabel
                ? [
                    {
                      tag: {
                        value: parsedEvent.eventTypeLabel,
                        color: parsedEvent.eventType === "outOfOffice" ? "#F6BF27" : "#7066FE",
                      },
                    },
                  ]
                : []),
              ...(parsedEvent.timezone ? [{ tag: { value: parsedEvent.timezone, color: "#7CB442" } }] : []),
              ...(parsedEvent.matchedCalendar
                ? [
                    {
                      tag: { value: parsedEvent.matchedCalendar, color: parsedEvent.matchedCalendarColor ?? "#616161" },
                    },
                  ]
                : []),
            ]}
            actions={
              <ActionPanel title="Add to calendar">
                {orderedCalendars.map((cal, index) => (
                  <Action
                    key={cal.id}
                    title={`Add to '${cal.name}'`}
                    onAction={() => createEvent(parsedEvent, cal.id)}
                    icon={Icon.Calendar}
                    shortcut={{ modifiers: ["cmd"], key: (index + 1).toString() as Keyboard.KeyEquivalent }}
                  />
                ))}
              </ActionPanel>
            }
          />
        </List.Section>
      )}
    </List>
  );
}

export default withGoogleAPIs(QuickCreateEvent);
