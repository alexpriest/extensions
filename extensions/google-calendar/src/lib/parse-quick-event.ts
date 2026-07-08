import { nanoid } from "nanoid";
import Fuse from "fuse.js";
import {
  addYears,
  addDays,
  isSameDay,
  isPast,
  startOfDay,
  addHours,
  addMinutes,
  roundToNearestMinutes,
  format,
} from "date-fns";
import parseDuration from "parse-duration";
import Sherlock from "sherlockjs";

// ============= Types =============

export type EventType = "default" | "outOfOffice" | "focusTime";

export interface QuickEvent {
  id: string;
  eventTitle: string | null;
  startDate: Date;
  endDate: Date;
  isAllDay: boolean;
  matchedCalendar?: string;
  matchedCalendarColor?: string;
  timezone?: string;
  eventType: EventType;
  durationMs?: number;
  recurrence?: string;
  recurrenceLabel?: string;
  recurrenceDayOfWeek?: number;
  location?: string;
  description?: string;
  urls?: string[];
  showAs?: "busy" | "free";
  attendees?: string[];
  alertMinutes?: number;
  apiLimitationWarning?: string; // Warning when API doesn't support requested feature
}

export type ParsedQuickEvent = QuickEvent & { eventTypeLabel?: string };

export interface CalendarInfo {
  id: string;
  name: string;
  color?: string;
}

// ============= Timezone Handling =============

const TIMEZONE_OFFSETS: Record<string, number> = {
  // US timezones (full)
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
  AKST: -540,
  AKDT: -480,
  HST: -600,
  // US timezones (short) - resolved dynamically below via DST_AWARE_ZONES
  // ET, CT, MT, PT are handled in extractTimezone()
  // European
  GMT: 0,
  UTC: 0,
  WET: 0,
  WEST: 60,
  CET: 60,
  CEST: 120,
  EET: 120,
  EEST: 180,
  // Asia/Pacific
  IST: 330,
  JST: 540,
  AEST: 600,
  AEDT: 660,
  NZST: 720,
  NZDT: 780,
};

// Map US zone abbreviations — including the explicit standard/daylight (S/D)
// variants — to IANA zones so the offset is computed with DST awareness at the
// event date. A user typing "PST" in July almost always means Pacific wall time,
// so we resolve it the same as "PT" (both -7 in summer) rather than a rigid -8.
const DST_AWARE_ZONES: Record<string, string> = {
  ET: "America/New_York",
  CT: "America/Chicago",
  MT: "America/Denver",
  PT: "America/Los_Angeles",
  EST: "America/New_York",
  EDT: "America/New_York",
  CST: "America/Chicago",
  CDT: "America/Chicago",
  MST: "America/Denver",
  MDT: "America/Denver",
  PST: "America/Los_Angeles",
  PDT: "America/Los_Angeles",
  AKST: "America/Anchorage",
  AKDT: "America/Anchorage",
};

function getDSTAwareOffset(tz: string, date: Date = new Date()): number | undefined {
  const iana = DST_AWARE_ZONES[tz.toUpperCase()];
  if (!iana) return undefined;
  const utcStr = date.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = date.toLocaleString("en-US", { timeZone: iana });
  return (new Date(tzStr).getTime() - new Date(utcStr).getTime()) / (60 * 1000);
}

function extractTimezone(
  query: string,
  consumedTimeSpans?: string[],
): { query: string; timezone: string | null; offsetMinutes: number | null } {
  const tzList =
    "EST|EDT|CST|CDT|MST|MDT|PST|PDT|AKST|AKDT|HST|ET|CT|MT|PT|GMT|UTC|WET|WEST|CET|CEST|EET|EEST|IST|JST|AEST|AEDT|NZST|NZDT";

  // Match timezone after various time formats:
  // - "3pm PT", "3:30pm PT" (standard)
  // - "930 PT", "1030 PT" (bare 3-4 digit times)
  // - "9-930 PT", "9-10 PT" (time ranges)
  // - "14h PT", "14h30 CET" (EU 24h times)
  const timePatterns = [
    `\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)`, // 3pm, 3:30pm
    `\\d{1,2}[uh]\\d{0,2}`, // 14h, 14h30, 9u30
    `\\d{3,4}`, // 930, 1030
    `\\d{1,2}\\s*-\\s*\\d{1,4}(?:\\s*(?:am|pm))?`, // 9-930, 9-10, 9-5, 10-1030, 2-3pm
  ];
  const tzPattern = new RegExp(`(?:${timePatterns.join("|")})\\s+(${tzList})\\b`, "gi");

  const match = query.match(tzPattern);
  if (match) {
    const fullMatch = match[0];
    const tzMatch = fullMatch.match(new RegExp(`\\s*(${tzList})$`, "i"));
    if (tzMatch) {
      const tz = tzMatch[1].toUpperCase();
      const offset = getDSTAwareOffset(tz) ?? TIMEZONE_OFFSETS[tz];
      if (offset !== undefined) {
        // Record the time portion (without the tz token) so the title deriver
        // can strip it — e.g. "930" in "standup 930 EST".
        if (consumedTimeSpans) {
          const timePart = fullMatch.slice(0, fullMatch.length - tzMatch[0].length).trim();
          if (timePart) consumedTimeSpans.push(timePart);
        }
        const cleanedQuery = query.replace(new RegExp(`\\s+${tz}\\b`, "gi"), "");
        return { query: cleanedQuery, timezone: tz, offsetMinutes: offset };
      }
    }
  }
  return { query, timezone: null, offsetMinutes: null };
}

function applyTimezone(date: Date, offsetMinutes: number): Date {
  const localOffset = date.getTimezoneOffset();
  const diffMinutes = -offsetMinutes - localOffset;
  return new Date(date.getTime() + diffMinutes * 60 * 1000);
}

// ============= Duration Extraction =============

function extractDuration(query: string): { query: string; durationMs: number | null; isAllDay: boolean } {
  // First check for "all day" or "allday" as standalone keywords (also "=allday",
  // consuming the leading "=" so it doesn't strand in the title)
  const allDayPattern = /(?:=\s*)?\b(all\s*day|allday)\b/i;
  if (allDayPattern.test(query)) {
    return {
      query: query.replace(allDayPattern, " ").replace(/\s+/g, " ").trim(),
      durationMs: null,
      isAllDay: true,
    };
  }

  // Match =30m, =1h, =2h30m, etc.
  const durationPattern = /\s*=\s*([\d]+[hm][\d]*[hm]?|[\d]+)\s*/gi;

  const match = query.match(durationPattern);
  if (match) {
    const durationStr = match[0]
      .replace(/^[\s=]+/, "")
      .trim()
      .toLowerCase();

    // Parse duration string (e.g., "30m", "1h", "2h30m")
    const ms = parseDuration(durationStr);
    if (ms && ms > 0) {
      return {
        query: query.replace(durationPattern, " ").trim(),
        durationMs: ms,
        isAllDay: false,
      };
    }
  }
  return { query, durationMs: null, isAllDay: false };
}

// ============= Event Type Extraction =============

const EVENT_TYPE_PATTERNS: { pattern: RegExp; type: EventType; label: string }[] = [
  // OOO patterns - must come before focus patterns
  { pattern: /\b(ooo|out\s+of\s+office|oof)\b/i, type: "outOfOffice", label: "OOO" },
  // Focus time patterns
  {
    pattern: /\b(focus\s+time|focustime|ft|focus|deep\s+work|deepwork|do\s+not\s+disturb|dnd)\b/i,
    type: "focusTime",
    label: "Focus",
  },
];

function extractEventType(query: string): { query: string; eventType: EventType; eventTypeLabel?: string } {
  for (const { pattern, type, label } of EVENT_TYPE_PATTERNS) {
    if (pattern.test(query)) {
      return {
        query: query.replace(pattern, "").replace(/\s+/g, " ").trim(),
        eventType: type,
        eventTypeLabel: label,
      };
    }
  }
  return { query, eventType: "default" };
}

// ============= Recurrence Extraction =============

interface RecurrenceResult {
  query: string;
  recurrence: string | null;
  recurrenceLabel?: string;
  dayOfWeek?: number; // 0=Sunday, 1=Monday, etc. - for adjusting start date
}

function extractRecurrence(query: string): RecurrenceResult {
  // Day name patterns
  const dayMap: Record<string, string> = {
    sunday: "SU",
    sun: "SU",
    monday: "MO",
    mon: "MO",
    tuesday: "TU",
    tue: "TU",
    tues: "TU",
    wednesday: "WE",
    wed: "WE",
    thursday: "TH",
    thu: "TH",
    thur: "TH",
    thurs: "TH",
    friday: "FR",
    fri: "FR",
    saturday: "SA",
    sat: "SA",
  };

  // Map day names to day of week numbers (0=Sunday)
  const dayNumMap: Record<string, number> = {
    sunday: 0,
    sun: 0,
    monday: 1,
    mon: 1,
    tuesday: 2,
    tue: 2,
    tues: 2,
    wednesday: 3,
    wed: 3,
    thursday: 4,
    thu: 4,
    thur: 4,
    thurs: 4,
    friday: 5,
    fri: 5,
    saturday: 6,
    sat: 6,
  };

  // Ordinal map for "every Nth [day]" patterns
  const ordinalMap: Record<string, number> = {
    first: 1,
    "1st": 1,
    second: 2,
    "2nd": 2,
    third: 3,
    "3rd": 3,
    fourth: 4,
    "4th": 4,
    fifth: 5,
    "5th": 5,
    last: -1,
  };

  // Every [ordinal] [day] pattern (e.g., "every third Thursday", "every last Friday")
  const everyOrdinalDayPattern =
    /\bevery\s+(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|last)\s+(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/i;
  const everyOrdinalDayMatch = query.match(everyOrdinalDayPattern);
  if (everyOrdinalDayMatch) {
    const ordinalStr = everyOrdinalDayMatch[1].toLowerCase();
    const dayName = everyOrdinalDayMatch[2].toLowerCase();
    const ordinal = ordinalMap[ordinalStr];
    const dayCode = dayMap[dayName] || dayMap[dayName.slice(0, 3)];
    const dayNum = dayNumMap[dayName] ?? dayNumMap[dayName.slice(0, 3)];
    if (dayCode && ordinal !== undefined) {
      const ordinalLabel = ordinalStr.charAt(0).toUpperCase() + ordinalStr.slice(1);
      const dayLabel = dayName.charAt(0).toUpperCase() + dayName.slice(1);
      return {
        query: query.replace(everyOrdinalDayPattern, "").replace(/\s+/g, " ").trim(),
        recurrence: `RRULE:FREQ=MONTHLY;BYDAY=${ordinal}${dayCode}`,
        recurrenceLabel: `${ordinalLabel} ${dayLabel}`,
        dayOfWeek: dayNum,
      };
    }
  }

  // Every [day] pattern (e.g., "every Monday", "every tue")
  const everyDayPattern =
    /\bevery\s+(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\b/i;
  const everyDayMatch = query.match(everyDayPattern);
  if (everyDayMatch) {
    const dayName = everyDayMatch[1].toLowerCase();
    const dayCode = dayMap[dayName] || dayMap[dayName.slice(0, 3)];
    const dayNum = dayNumMap[dayName] ?? dayNumMap[dayName.slice(0, 3)];
    if (dayCode) {
      return {
        query: query.replace(everyDayPattern, "").replace(/\s+/g, " ").trim(),
        recurrence: `RRULE:FREQ=WEEKLY;BYDAY=${dayCode}`,
        recurrenceLabel: `Every ${everyDayMatch[1].charAt(0).toUpperCase() + everyDayMatch[1].slice(1).toLowerCase()}`,
        dayOfWeek: dayNum,
      };
    }
  }

  // Every weekday pattern
  const everyWeekdayPattern = /\bevery\s+weekday\b/i;
  if (everyWeekdayPattern.test(query)) {
    return {
      query: query.replace(everyWeekdayPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      recurrenceLabel: "Every weekday",
    };
  }

  // Every weekend pattern
  const everyWeekendPattern = /\bevery\s+weekend\b/i;
  if (everyWeekendPattern.test(query)) {
    return {
      query: query.replace(everyWeekendPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=SA,SU",
      recurrenceLabel: "Every weekend",
    };
  }

  // Every morning/afternoon/evening (treat as daily, and inject the time)
  const everyTimeOfDayPattern = /\bevery\s+(morning|afternoon|evening|night)\b/i;
  const everyTimeMatch = query.match(everyTimeOfDayPattern);
  if (everyTimeMatch) {
    const timeOfDay = everyTimeMatch[1].toLowerCase();
    const timeMap: Record<string, string> = {
      morning: "9am",
      afternoon: "2pm",
      evening: "6pm",
      night: "8pm",
    };
    // Replace "every morning" with the time so it gets parsed
    const newQuery = query
      .replace(everyTimeOfDayPattern, timeMap[timeOfDay] || "")
      .replace(/\s+/g, " ")
      .trim();
    return {
      query: newQuery,
      recurrence: "RRULE:FREQ=DAILY",
      recurrenceLabel: "Daily",
    };
  }

  // Every day / daily pattern
  const dailyPattern = /\b(every\s+day|daily)\b/i;
  if (dailyPattern.test(query)) {
    return {
      query: query.replace(dailyPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=DAILY",
      recurrenceLabel: "Daily",
    };
  }

  // Every week / weekly pattern
  const weeklyPattern = /\b(every\s+week|weekly)\b/i;
  if (weeklyPattern.test(query)) {
    return {
      query: query.replace(weeklyPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=WEEKLY",
      recurrenceLabel: "Weekly",
    };
  }

  // Every month / monthly pattern
  const monthlyPattern = /\b(every\s+month|monthly)\b/i;
  if (monthlyPattern.test(query)) {
    return {
      query: query.replace(monthlyPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=MONTHLY",
      recurrenceLabel: "Monthly",
    };
  }

  // Every year / yearly / annually pattern
  const yearlyPattern = /\b(every\s+year|yearly|annually)\b/i;
  if (yearlyPattern.test(query)) {
    return {
      query: query.replace(yearlyPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=YEARLY",
      recurrenceLabel: "Yearly",
    };
  }

  return { query, recurrence: null };
}

// ============= Multi-day Date Range Extraction =============

interface DateRangeResult {
  query: string;
  startDate: Date | null;
  endDate: Date | null;
}

// Common separator pattern for date ranges
const DATE_RANGE_SEPARATORS = "\\s*(?:-|–|—|to|through|thru|until|til|till)\\s*";

function extractDateRange(query: string): DateRangeResult {
  const months =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const days =
    "mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?";
  const relativeDates = "today|tomorrow|yesterday";
  const ordinals = "(?:st|nd|rd|th)?";

  // Pattern 1: Relative date through Month Day (e.g., "tomorrow through Jan 3rd", "today until Friday")
  // Using explicit pattern for better matching
  const relativeThroughMonthDayPattern =
    /\b(today|tomorrow|yesterday)\s+(?:through|thru|until|til|till|to|-|–|—)\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?\b/i;
  const relativeThroughMonthDayMatch = query.match(relativeThroughMonthDayPattern);
  if (relativeThroughMonthDayMatch) {
    const relativeWord = relativeThroughMonthDayMatch[1].toLowerCase();
    const endMonth = parseMonth(relativeThroughMonthDayMatch[2]);
    const endDay = parseInt(relativeThroughMonthDayMatch[3], 10);

    const now = new Date();
    const startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);

    if (relativeWord === "tomorrow") {
      startDate.setDate(now.getDate() + 1);
    } else if (relativeWord === "yesterday") {
      startDate.setDate(now.getDate() - 1);
    }

    let endYear = now.getFullYear();
    const endDate = new Date(endYear, endMonth, endDay);
    // If end date is before start, it's next year
    if (endDate < startDate) {
      endYear++;
      endDate.setFullYear(endYear);
    }
    endDate.setDate(endDate.getDate() + 1); // +1 for all-day end date

    return {
      query: query.replace(relativeThroughMonthDayPattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  // Pattern 2: Relative date through day of week (e.g., "today through Friday", "tomorrow until Sunday")
  const relativeThroughDayPattern = new RegExp(`\\b(${relativeDates})${DATE_RANGE_SEPARATORS}(${days})\\b`, "i");
  const relativeThroughDayMatch = query.match(relativeThroughDayPattern);
  if (relativeThroughDayMatch) {
    const relativeWord = relativeThroughDayMatch[1].toLowerCase();
    const endDayOfWeek = parseDayOfWeek(relativeThroughDayMatch[2]);

    const now = new Date();
    const startDate = new Date(now);
    startDate.setHours(0, 0, 0, 0);

    if (relativeWord === "tomorrow") {
      startDate.setDate(now.getDate() + 1);
    } else if (relativeWord === "yesterday") {
      startDate.setDate(now.getDate() - 1);
    }

    // Find the next occurrence of end day after start
    const startDayOfWeek = startDate.getDay();
    let daysUntilEnd = endDayOfWeek - startDayOfWeek;
    if (daysUntilEnd <= 0) daysUntilEnd += 7;

    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + daysUntilEnd + 1); // +1 for all-day end date

    return {
      query: query.replace(relativeThroughDayPattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  // Pattern 3: Same-month date range (e.g., "Feb 3-26", "Feb 3-26, 2027")
  // Must come before cross-month patterns to match "feb 3-26" before it's misinterpreted
  const sameMonthRangeWithYearPattern = new RegExp(
    `\\b(${months})\\s*(\\d{1,2})${ordinals}\\s*[-–—]\\s*(\\d{1,2})${ordinals}[,\\s]+(\\d{4})\\b`,
    "i",
  );
  const sameMonthWithYearMatch = query.match(sameMonthRangeWithYearPattern);
  if (sameMonthWithYearMatch) {
    const month = parseMonth(sameMonthWithYearMatch[1]);
    const startDay = parseInt(sameMonthWithYearMatch[2], 10);
    const endDay = parseInt(sameMonthWithYearMatch[3], 10);
    const year = parseInt(sameMonthWithYearMatch[4], 10);

    const startDate = new Date(year, month, startDay);
    const endDate = new Date(year, month, endDay + 1);

    return {
      query: query.replace(sameMonthRangeWithYearPattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  const sameMonthRangePattern = new RegExp(
    `\\b(${months})\\s*(\\d{1,2})${ordinals}\\s*[-–—]\\s*(\\d{1,2})${ordinals}\\b`,
    "i",
  );
  const sameMonthMatch = query.match(sameMonthRangePattern);
  if (sameMonthMatch) {
    const month = parseMonth(sameMonthMatch[1]);
    const startDay = parseInt(sameMonthMatch[2], 10);
    const endDay = parseInt(sameMonthMatch[3], 10);

    const now = new Date();
    let year = now.getFullYear();
    const startDate = new Date(year, month, startDay);
    if (startDate < now) {
      year++;
      startDate.setFullYear(year);
    }
    const endDate = new Date(year, month, endDay + 1);

    return {
      query: query.replace(sameMonthRangePattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  // Pattern 4a: Month day, year - Month day (e.g., "Dec 26, 2027 - Jan 3") - year on START date
  const monthDayRangeWithStartYearPattern = new RegExp(
    `\\b(${months})\\s*(\\d{1,2})${ordinals}[,\\s]+(\\d{4})${DATE_RANGE_SEPARATORS}(${months})\\s*(\\d{1,2})${ordinals}\\b`,
    "i",
  );
  const monthDayWithStartYearMatch = query.match(monthDayRangeWithStartYearPattern);
  if (monthDayWithStartYearMatch) {
    const startMonth = parseMonth(monthDayWithStartYearMatch[1]);
    const startDay = parseInt(monthDayWithStartYearMatch[2], 10);
    const specifiedYear = parseInt(monthDayWithStartYearMatch[3], 10);
    const endMonth = parseMonth(monthDayWithStartYearMatch[4]);
    const endDay = parseInt(monthDayWithStartYearMatch[5], 10);

    // Year was on start date - use it for start
    const startYear = specifiedYear;
    // End year is next year if end month < start month (e.g., Dec-Jan)
    const endYear = endMonth < startMonth ? specifiedYear + 1 : specifiedYear;

    const startDate = new Date(startYear, startMonth, startDay);
    const endDate = new Date(endYear, endMonth, endDay + 1);

    return {
      query: query.replace(monthDayRangeWithStartYearPattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  // Pattern 4b: Month day - Month day, year (e.g., "Dec 26 - Jan 3, 2027") - year on END date
  const monthDayRangeWithEndYearPattern = new RegExp(
    `\\b(${months})\\s*(\\d{1,2})${ordinals}${DATE_RANGE_SEPARATORS}(${months})\\s*(\\d{1,2})${ordinals}[,\\s]+(\\d{4})\\b`,
    "i",
  );
  const monthDayWithEndYearMatch = query.match(monthDayRangeWithEndYearPattern);
  if (monthDayWithEndYearMatch) {
    const startMonth = parseMonth(monthDayWithEndYearMatch[1]);
    const startDay = parseInt(monthDayWithEndYearMatch[2], 10);
    const endMonth = parseMonth(monthDayWithEndYearMatch[3]);
    const endDay = parseInt(monthDayWithEndYearMatch[4], 10);
    const specifiedYear = parseInt(monthDayWithEndYearMatch[5], 10);

    // Year was on end date - use it for end
    const endYear = specifiedYear;
    // Start year is previous year if start month > end month (e.g., Dec-Jan)
    const startYear = startMonth > endMonth ? specifiedYear - 1 : specifiedYear;

    const startDate = new Date(startYear, startMonth, startDay);
    const endDate = new Date(endYear, endMonth, endDay + 1);

    return {
      query: query.replace(monthDayRangeWithEndYearPattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  // Pattern 3b: Month day - Month day without year (e.g., "Dec 26 - Jan 2", "Dec 26-Jan2")
  const monthDayRangePattern = new RegExp(
    `\\b(${months})\\s*(\\d{1,2})${ordinals}${DATE_RANGE_SEPARATORS}(${months})\\s*(\\d{1,2})${ordinals}\\b`,
    "i",
  );
  const monthDayMatch = query.match(monthDayRangePattern);
  if (monthDayMatch) {
    const startMonth = parseMonth(monthDayMatch[1]);
    const startDay = parseInt(monthDayMatch[2], 10);
    const endMonth = parseMonth(monthDayMatch[3]);
    const endDay = parseInt(monthDayMatch[4], 10);

    const now = new Date();
    let startYear = now.getFullYear();
    let endYear = now.getFullYear();

    const startDate = new Date(startYear, startMonth, startDay);
    if (startDate < now) {
      startYear++;
      startDate.setFullYear(startYear);
    }

    if (endMonth < startMonth) {
      endYear = startYear + 1;
    } else {
      endYear = startYear;
    }

    const endDate = new Date(endYear, endMonth, endDay + 1);

    return {
      query: query.replace(monthDayRangePattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  // Pattern 4: Day - Day (e.g., "Monday - Friday", "Mon through Fri", "next Mon through Wed")
  const dayRangePattern = new RegExp(`\\b(?:next\\s+|this\\s+)?(${days})${DATE_RANGE_SEPARATORS}(${days})\\b`, "i");
  const dayRangeMatch = query.match(dayRangePattern);
  if (dayRangeMatch) {
    const startDayOfWeek = parseDayOfWeek(dayRangeMatch[1]);
    const endDayOfWeek = parseDayOfWeek(dayRangeMatch[2]);

    const now = new Date();
    const currentDay = now.getDay();

    let daysUntilStart = startDayOfWeek - currentDay;
    if (daysUntilStart <= 0) daysUntilStart += 7;

    const startDate = new Date(now);
    startDate.setDate(now.getDate() + daysUntilStart);
    startDate.setHours(0, 0, 0, 0);

    let daysUntilEnd = endDayOfWeek - startDayOfWeek;
    if (daysUntilEnd <= 0) daysUntilEnd += 7;

    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + daysUntilEnd + 1);

    return {
      query: query.replace(dayRangePattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  // Pattern 5: "next week" as a date range (Monday through Friday)
  const nextWeekPattern = /\bnext\s+week\b/i;
  if (nextWeekPattern.test(query)) {
    const now = new Date();
    const currentDay = now.getDay();

    // Find next Monday
    let daysUntilMonday = 1 - currentDay;
    if (daysUntilMonday <= 0) daysUntilMonday += 7;

    const startDate = new Date(now);
    startDate.setDate(now.getDate() + daysUntilMonday);
    startDate.setHours(0, 0, 0, 0);

    // End on Saturday (day after Friday for all-day)
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 5);

    return {
      query: query.replace(nextWeekPattern, "").replace(/\s+/g, " ").trim(),
      startDate,
      endDate,
    };
  }

  return { query, startDate: null, endDate: null };
}

function parseMonth(monthStr: string): number {
  const months: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
  };
  return months[monthStr.toLowerCase()] ?? 0;
}

function parseDayOfWeek(dayStr: string): number {
  const days: Record<string, number> = {
    sun: 0,
    sunday: 0,
    mon: 1,
    monday: 1,
    tue: 2,
    tues: 2,
    tuesday: 2,
    wed: 3,
    wednesday: 3,
    thu: 4,
    thur: 4,
    thurs: 4,
    thursday: 4,
    fri: 5,
    friday: 5,
    sat: 6,
    saturday: 6,
  };
  const normalized = dayStr.toLowerCase().replace(/day$/, "");
  return days[normalized] ?? days[dayStr.toLowerCase()] ?? 0;
}

// ============= Location Extraction =============

function extractLocation(query: string): { query: string; location?: string } {
  // Match @(multi word location) or @single-word
  // Must be preceded by whitespace or start of string (not part of an email)
  // For parenthesized: @(Conference Room B)
  const parenPattern = /(?:^|\s)@\(([^)]+)\)/;
  const parenMatch = query.match(parenPattern);
  if (parenMatch) {
    return {
      query: query.replace(parenPattern, " ").replace(/\s+/g, " ").trim(),
      location: parenMatch[1],
    };
  }

  // For unparenthesized @location: capture the first word, plus any following
  // Capitalized words (multi-word venue names like "@Rooftop Bar", "@Franklin
  // BBQ"). The run stops at a lowercase word, a time/modifier, or punctuation,
  // so "@home tomorrow" → "home" and "@Uchi 7pm" → "Uchi". Not preceded by word
  // characters (which would indicate an email).
  const singlePattern = /(?:^|\s)@([a-zA-Z][\w-]*(?:\s+[A-Z][\w-]*)*)\b(?![.@])/;
  const singleMatch = query.match(singlePattern);
  if (singleMatch) {
    // Capitalized weekdays/relatives/months (e.g. "@Rooftop Bar Friday") are date
    // words, not part of the venue — cut the run at the first one so the date
    // still parses and doesn't pollute the location.
    const stopWord = new RegExp(`^(?:${DAY_NAMES_SRC}|${MONTHS_SRC}|today|tomorrow|tonight|yesterday|tmrw|tom)$`, "i");
    const words = singleMatch[1].split(/\s+/);
    let keep = 1;
    while (keep < words.length && !stopWord.test(words[keep])) keep++;
    const location = words.slice(0, keep).join(" ");
    return {
      query: query.replace("@" + location, " ").replace(/\s+/g, " ").trim(),
      location,
    };
  }

  return { query };
}

// ============= Notes Extraction =============

function extractNotes(query: string): { query: string; description?: string } {
  // Match // followed by anything
  const notesPattern = /\s*\/\/\s*(.+)$/;
  const match = query.match(notesPattern);
  if (match) {
    return {
      query: query.replace(notesPattern, "").trim(),
      description: match[1].trim(),
    };
  }
  return { query };
}

// ============= URL Extraction =============

function extractUrls(query: string): { query: string; urls?: string[] } {
  // Match URLs (http/https)
  const urlPattern = /https?:\/\/[^\s]+/gi;
  const matches = query.match(urlPattern);
  if (matches && matches.length > 0) {
    return {
      query: query.replace(urlPattern, "").replace(/\s+/g, " ").trim(),
      urls: matches,
    };
  }
  return { query };
}

// ============= Show As (Busy/Free) Extraction =============

function extractShowAs(query: string): { query: string; showAs?: "busy" | "free" } {
  // Using ~ prefix to avoid macOS text replacement (e.g., !fr → ₣)
  const busyPattern = /\s*~busy\b/i;
  const freePattern = /\s*~free\b/i;

  if (freePattern.test(query)) {
    return {
      query: query.replace(freePattern, "").replace(/\s+/g, " ").trim(),
      showAs: "free",
    };
  }
  if (busyPattern.test(query)) {
    return {
      query: query.replace(busyPattern, "").replace(/\s+/g, " ").trim(),
      showAs: "busy",
    };
  }
  return { query };
}

// ============= Attendees Extraction =============

function extractAttendees(query: string): { query: string; attendees?: string[] } {
  // Match "with <email>" followed by any number of further emails separated by
  // commas, spaces, "and", or "&" — e.g. "with a@x.com, b@x.com and c@x.com".
  // The run stops at the first non-email token, so "with bob@x.com about foo"
  // keeps "about foo" in the title.
  const email = `[\\w.+-]+@[\\w.-]+\\.[\\w-]+`;
  const withPattern = new RegExp(`\\bwith\\s+(${email}(?:\\s*(?:,|and|&|\\s)\\s*${email})*)`, "gi");
  const matches: string[] = [];
  let match;

  while ((match = withPattern.exec(query)) !== null) {
    const emails = match[1].match(new RegExp(email, "g"));
    if (emails) matches.push(...emails);
  }

  if (matches.length > 0) {
    return {
      query: query.replace(withPattern, " ").replace(/\s+/g, " ").trim(),
      attendees: matches,
    };
  }
  return { query };
}

// ============= Alert/Reminder Extraction =============

function extractAlert(query: string): { query: string; alertMinutes?: number } {
  // Match "alert 15m", "alert 1h", "remind 30min", "reminder 1 hour", or shorthand "!15m", "!1h"
  const alertPattern = /\s*(?:alert|remind(?:er)?)\s+(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)\b/i;
  const shorthandPattern = /\s*!(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)\b/i;

  const match = query.match(alertPattern) || query.match(shorthandPattern);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const minutes = unit.startsWith("h") ? value * 60 : value;
    const patternUsed = query.match(alertPattern) ? alertPattern : shorthandPattern;
    return {
      query: query.replace(patternUsed, "").replace(/\s+/g, " ").trim(),
      alertMinutes: minutes,
    };
  }
  return { query };
}

// ============= "For X" Duration Extraction =============

function extractForDuration(query: string): { query: string; durationMs?: number } {
  // Match "for 30 minutes", "for 1 hour", "for 2h", "for 90min"
  const forPattern = /\s+for\s+(\d+)\s*(m(?:in(?:ute)?s?)?|h(?:(?:ou)?rs?)?)\b/i;
  const match = query.match(forPattern);
  if (match) {
    const value = parseInt(match[1], 10);
    const unit = match[2].toLowerCase();
    const ms = unit.startsWith("h") ? value * 60 * 60 * 1000 : value * 60 * 1000;
    return {
      query: query.replace(forPattern, "").replace(/\s+/g, " ").trim(),
      durationMs: ms,
    };
  }
  return { query };
}

// ============= Time Keywords =============

function expandTimeKeywords(query: string): string {
  // Replace time-of-day keywords with specific times
  const replacements: [RegExp, string][] = [
    [/\bmorning\b/gi, "9am"],
    [/\bnoon\b/gi, "12pm"],
    [/\bafternoon\b/gi, "2pm"],
    [/\bevening\b/gi, "6pm"],
    [/\bnight\b/gi, "8pm"],
    [/\bmidnight\b/gi, "12am"],
    [/\btmrw\b/gi, "tomorrow"],
    [/\btom\b/gi, "tomorrow"],
  ];

  for (const [pattern, replacement] of replacements) {
    query = query.replace(pattern, replacement);
  }
  return query;
}

// ============= Extended Recurrence =============

function extractExtendedRecurrence(query: string): { query: string; recurrence?: string; recurrenceLabel?: string } {
  // "every other week" / "biweekly" / "every 2 weeks"
  const everyOtherWeekPattern = /\b(?:every\s+other\s+week|biweekly|every\s+2\s+weeks?)\b/i;
  if (everyOtherWeekPattern.test(query)) {
    return {
      query: query.replace(everyOtherWeekPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=WEEKLY;INTERVAL=2",
      recurrenceLabel: "Every 2 weeks",
    };
  }

  // "every other day"
  const everyOtherDayPattern = /\bevery\s+other\s+day\b/i;
  if (everyOtherDayPattern.test(query)) {
    return {
      query: query.replace(everyOtherDayPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: "RRULE:FREQ=DAILY;INTERVAL=2",
      recurrenceLabel: "Every 2 days",
    };
  }

  // "every N weeks/days/months"
  const everyNPattern = /\bevery\s+(\d+)\s+(day|week|month)s?\b/i;
  const everyNMatch = query.match(everyNPattern);
  if (everyNMatch) {
    const interval = parseInt(everyNMatch[1], 10);
    const unit = everyNMatch[2].toUpperCase();
    const freq = unit === "DAY" ? "DAILY" : unit === "WEEK" ? "WEEKLY" : "MONTHLY";
    return {
      query: query.replace(everyNPattern, "").replace(/\s+/g, " ").trim(),
      recurrence: `RRULE:FREQ=${freq};INTERVAL=${interval}`,
      recurrenceLabel: `Every ${interval} ${everyNMatch[2].toLowerCase()}${interval > 1 ? "s" : ""}`,
    };
  }

  return { query };
}

// ============= Date Helpers =============

function adjustPastDate(date: Date, isAllDay: boolean): Date {
  const now = new Date();
  const compareDate = isAllDay ? startOfDay(date) : date;
  const compareNow = isAllDay ? startOfDay(now) : now;

  if (isPast(compareDate) && compareDate < compareNow) {
    return addYears(date, 1);
  }
  return date;
}

function getDefaultStartDate(): Date {
  const startDate = addMinutes(new Date(), 15);
  return roundToNearestMinutes(startDate, { nearestTo: 30 });
}

function getDefaultEndDate(startDate: Date): Date {
  return addHours(startDate, 1);
}

// Placeholder tokens used to protect substrings from Sherlock's date/time parsing.
const ONE_ON_ONE_TOKEN = "ONE_ON_ONE_MEETING";
const HYPHEN_TOKEN = "WDHYPHN";
const AND_TOKEN = "WDANDX";

function preprocessQuery(query: string, matchedTimeSpans?: string[]): string {
  const recordSpan = (span: string) => {
    if (matchedTimeSpans && span.trim()) matchedTimeSpans.push(span.trim());
  };

  // Protect common meeting patterns from being parsed as times
  // Replace with placeholder that won't be parsed, then we'll handle in title
  const meetingPatterns = [
    { pattern: /\b1-on-1s?\b/gi, replacement: ONE_ON_ONE_TOKEN },
    { pattern: /\b1:1s?\b/gi, replacement: ONE_ON_ONE_TOKEN },
    { pattern: /\bone-on-ones?\b/gi, replacement: ONE_ON_ONE_TOKEN },
  ];
  for (const { pattern, replacement } of meetingPatterns) {
    query = query.replace(pattern, replacement);
  }

  // Convert compact times in ranges: "515-10pm" → "5:15-10pm", "1030-2pm" → "10:30-2pm"
  // Also handles shorthand suffix "a"/"p" when directly attached: "830-1130a" → 8:30am-11:30am
  // Must run before time range patterns so they can then match the normalized format
  const compactTimeRangePattern = /\b(\d{3,4})\s*-\s*(\d{1,4})(?:\s*(am|pm)|([ap]))\b/gi;
  query = query.replace(compactTimeRangePattern, (match, startRaw, endRaw, fullAmPm, shortAmPm) => {
    recordSpan(match);
    const ampm = fullAmPm ? fullAmPm.toLowerCase() : shortAmPm.toLowerCase() + "m";
    const formatCompact = (s: string) => {
      if (s.length === 3) return `${s[0]}:${s.slice(1)}`;
      if (s.length === 4) return `${s.slice(0, 2)}:${s.slice(2)}`;
      return s;
    };
    const start = formatCompact(startRaw);
    const end = formatCompact(endRaw);
    return `from ${start}${ampm} to ${end}${ampm}`;
  });

  // Convert time ranges like "2-3pm" to "from 2pm to 3pm"
  const timeRangePattern = /\b(\d{1,2}(?::\d{2})?)\s*-\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/gi;
  query = query.replace(timeRangePattern, (match, start, end, ampm) => {
    recordSpan(match);
    return `from ${start}${ampm} to ${end}${ampm}`;
  });

  // Handle "2pm-3pm" format
  const timeRangeWithBothPattern = /\b(\d{1,2}(?::\d{2})?)\s*(am|pm)\s*-\s*(\d{1,2}(?::\d{2})?)\s*(am|pm)\b/gi;
  query = query.replace(timeRangeWithBothPattern, (match, start, ampm1, end, ampm2) => {
    recordSpan(match);
    return `from ${start}${ampm1} to ${end}${ampm2}`;
  });

  // Handle bare compact ranges without am/pm like "830-1130", "1030-2", "830-11"
  // (compact 3-4 digit start, any end). Apply same cross-noon heuristic as simpleHourRangePattern.
  const bareCompactRangePattern = /\b(\d{3,4})\s*-\s*(\d{1,4})\b/g;
  query = query.replace(bareCompactRangePattern, (match, startRaw, endRaw) => {
    const startHour = parseInt(startRaw.length === 3 ? startRaw[0] : startRaw.slice(0, 2), 10);
    const endHour =
      endRaw.length >= 3 ? parseInt(endRaw.length === 3 ? endRaw[0] : endRaw.slice(0, 2), 10) : parseInt(endRaw, 10);
    if (startHour === 0 || endHour === 0 || startHour > 12 || endHour > 12) return match;
    // Reject likely non-times by requiring valid minute portions (<60)
    if (parseInt(startRaw.slice(-2), 10) >= 60) return match;
    if (endRaw.length >= 3 && parseInt(endRaw.slice(-2), 10) >= 60) return match;

    recordSpan(match);
    const startAmPm = startHour >= 5 && startHour < 12 ? "am" : "pm";
    let endAmPm = startAmPm;
    if (startAmPm === "am" && (endHour === 12 || endHour < startHour)) {
      endAmPm = "pm";
    }

    const formatCompact = (s: string) => {
      if (s.length === 3) return `${s[0]}:${s.slice(1)}`;
      if (s.length === 4) return `${s.slice(0, 2)}:${s.slice(2)}`;
      return s;
    };
    return `from ${formatCompact(startRaw)}${startAmPm} to ${formatCompact(endRaw)}${endAmPm}`;
  });

  // Handle bare time ranges without am/pm like "9-930", "9-10", "10-1030"
  // Convert 3-4 digit numbers to time format (930 → 9:30, 1030 → 10:30)
  const bareTimeRangePattern = /\b(\d{1,2})\s*-\s*(\d{3,4})\b/g;
  query = query.replace(bareTimeRangePattern, (match, startHour, endTime) => {
    // Don't match if it looks like a year range (e.g., 2020-2025)
    if (parseInt(startHour, 10) >= 19 || parseInt(endTime, 10) >= 1300) return match;

    recordSpan(match);
    // Convert endTime: 930 → 9:30, 1030 → 10:30
    const endStr =
      endTime.length === 3 ? `${endTime[0]}:${endTime.slice(1)}` : `${endTime.slice(0, 2)}:${endTime.slice(2)}`;

    // Determine am/pm - hours 1-4 default to PM (rare to have meetings at 1-4am)
    // Hours 5-11 default to AM, 12 defaults to PM
    const startH = parseInt(startHour, 10);
    const ampm = startH >= 5 && startH < 12 ? "am" : "pm";

    return `from ${startHour}${ampm} to ${endStr}${ampm}`;
  });

  // Handle 24-hour hour ranges where at least one bound is 13-23 (e.g. "14-16",
  // "9-17"). These are unambiguously 24h (a 5pm workday end is "17", not "5"),
  // so convert both bounds to explicit 24h times that Sherlock parses directly.
  const twentyFourHourRangePattern = /\b([01]?\d|2[0-3])\s*-\s*([01]?\d|2[0-3])\b/g;
  query = query.replace(twentyFourHourRangePattern, (match, startRaw, endRaw) => {
    const start = parseInt(startRaw, 10);
    const end = parseInt(endRaw, 10);
    // Only take over when a bound is clearly 24h (>12); otherwise leave it for
    // the am/pm-inferring simpleHourRangePattern below.
    if (start <= 12 && end <= 12) return match;
    if (start > 23 || end > 23) return match;
    recordSpan(match);
    const pad = (n: number) => `${n.toString().padStart(2, "0")}:00`;
    return `from ${pad(start)} to ${pad(end)}`;
  });

  // Handle simple hour ranges without am/pm like "9-10" (not caught by above)
  const simpleHourRangePattern = /\b(\d{1,2})\s*-\s*(\d{1,2})(?!\d|:|am|pm|h)\b/gi;
  query = query.replace(simpleHourRangePattern, (match, startHour, endHour) => {
    const start = parseInt(startHour, 10);
    const end = parseInt(endHour, 10);
    if (start > 12 || end > 12 || start === 0 || end === 0) return match;
    recordSpan(match);
    // Start: 5-11 default to AM (morning), 12 and 1-4 default to PM (noon/afternoon)
    const startAmPm = start >= 5 && start < 12 ? "am" : "pm";
    // End: if start is AM and end <= start numerically, end crosses noon into PM
    // (e.g., 11-1 → 11am-1pm, 9-5 → 9am-5pm). End = 12 also means noon.
    let endAmPm = startAmPm;
    if (startAmPm === "am" && (end === 12 || end < start)) {
      endAmPm = "pm";
    }
    return `from ${startHour}${startAmPm} to ${endHour}${endAmPm}`;
  });

  // EU time formats (14h, 14h30) - only valid hours 0-23
  // Use specific patterns to avoid matching invalid hours like 25h
  const timePattern = /\b(([01]?\d|2[0-3])([uUhH])(\d{2})?)\b/g;
  query = query.replace(timePattern, (match, _full, hour, _sep, minutes) => {
    recordSpan(match);
    const h = parseInt(hour, 10);
    const m = minutes ? parseInt(minutes, 10) : 0;
    const date = new Date();
    date.setHours(h, m, 0, 0);
    return format(date, "h:mm aa");
  });

  // Remove invalid EU-like patterns (e.g., 25h, 30h) so Sherlock doesn't misparse them as dates
  // These get kept in the title since we do this after EU time conversion
  query = query.replace(/\b([3-9]\d|2[4-9])h\b/gi, "");

  // Protect hyphens between words (e.g., "Parent-Teacher") from being parsed as
  // time range separators by Sherlock. Restored in title after parsing.
  query = query.replace(/([a-zA-Z])-([a-zA-Z])/g, `$1${HYPHEN_TOKEN}$2`);

  // Protect "and" from being parsed as a range splitter by Sherlock (it strips
  // "and Karan" from "Jeff and Karan" when a time precedes it). Restored in title.
  query = query.replace(/\band\b/gi, AND_TOKEN);

  // Move a trailing date to the front of the query.
  // Sherlock only applies a trailing date to the NEAREST time (the end time in a
  // range), so "12pm to 1pm tuesday" would put start today and end on Tuesday.
  // When the date leads, Sherlock applies it to both start and end. This covers
  // numeric dates (3/5), weekdays ((next) tuesday), relatives (tomorrow), and
  // month-day (Jan 3) — everything Sherlock resolves as a single date.
  const leadingDatePattern = new RegExp(
    "\\b(" +
      "\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?" + // 3/5, 12/25/2026
      "|(?:next\\s+|this\\s+)?(?:" +
      DAY_NAMES_SRC +
      ")" + // tuesday, next friday
      "|today|tomorrow|yesterday|tonight" +
      "|(?:" +
      MONTHS_SRC +
      ")\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?" + // Jan 3, Dec 5th 2027
      ")\\b",
    "i",
  );
  const dateMatch = query.match(leadingDatePattern);
  if (dateMatch && dateMatch.index !== undefined && dateMatch.index > 0) {
    query = dateMatch[1] + " " + query.replace(leadingDatePattern, " ").replace(/\s+/g, " ").trim();
  }

  return query;
}

// ============= Calendar Matching =============

function matchCalendar(calendarInput: string, calendarNames: string[]): string | undefined {
  if (!calendarInput || calendarNames.length === 0) {
    return undefined;
  }

  const normalizedInput = calendarInput.toLowerCase();

  // Exact match (case-insensitive)
  const exactMatch = calendarNames.find((cal) => cal.toLowerCase() === normalizedInput);
  if (exactMatch) {
    return exactMatch;
  }

  // Prefix match
  const prefixMatches = calendarNames.filter((cal) => cal.toLowerCase().startsWith(normalizedInput));
  if (prefixMatches.length === 1) {
    return prefixMatches[0];
  }

  // Fuzzy match
  const fuse = new Fuse(calendarNames, { threshold: 0.4, ignoreLocation: true });
  const fuseResults = fuse.search(calendarInput);
  if (fuseResults.length > 0) {
    return fuseResults[0].item;
  }

  return undefined;
}

// ============= Date Formatting =============

function formatRelativeDay(date: Date): string {
  const now = new Date();
  const diffDays = Math.floor((startOfDay(date).getTime() - startOfDay(now).getTime()) / (1000 * 60 * 60 * 24));

  switch (diffDays) {
    case -1:
      return "yesterday";
    case 0:
      return "today";
    case 1:
      return "tomorrow";
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
      return format(date, "EEEE");
    default:
      return format(date, "MMM d, yyyy");
  }
}

export function formatEventDate(event: QuickEvent): string {
  // Check if it's a multi-day event
  const startDay = startOfDay(event.startDate);
  const endDay = startOfDay(event.endDate);
  const daysDiff = Math.round((endDay.getTime() - startDay.getTime()) / (1000 * 60 * 60 * 24));

  if (event.isAllDay && daysDiff > 1) {
    // Multi-day all-day event
    const actualEndDate = new Date(event.endDate.getTime() - 86400000);
    const startYear = event.startDate.getFullYear();
    const endYear = actualEndDate.getFullYear();
    const currentYear = new Date().getFullYear();

    // Show years if crossing years or if not the current year
    const showYears = startYear !== endYear || startYear !== currentYear;

    // Build format with day names - use short day (EEE = Mon, Tue, etc.)
    const startDayName = format(event.startDate, "EEE");
    const endDayName = format(actualEndDate, "EEE");
    const startDateStr = format(event.startDate, showYears ? "MMM d, yyyy" : "MMM d");
    const endDateStr = format(actualEndDate, showYears ? "MMM d, yyyy" : "MMM d");

    // Include both day names if not too long, otherwise just start day
    const fullFormat = `${startDayName}, ${startDateStr} - ${endDayName}, ${endDateStr} (${daysDiff} days)`;
    const shortFormat = `${startDayName}, ${startDateStr} - ${endDateStr} (${daysDiff} days)`;

    // Use full format if under ~55 chars, otherwise use short format
    return fullFormat.length <= 55 ? fullFormat : shortFormat;
  }
  if (event.isAllDay) {
    return `${formatRelativeDay(event.startDate)} all-day`;
  }
  return `${formatRelativeDay(event.startDate)} from ${format(event.startDate, "h:mm a")} to ${format(event.endDate, "h:mm a")}`;
}

// ============= Title Extraction =============

// Protect double-quoted spans by swapping each for an opaque placeholder token.
// Straight ("...") and curly (“...”) double quotes are supported; single
// quotes/apostrophes are intentionally NOT delimiters (they collide with
// possessives like "Dad's birthday"). The placeholder is a bare word so no
// downstream extractor, Sherlock, or the title deriver touches it, then it is
// restored verbatim at the very end. This makes the quoted text literal title
// content while KEEPING any words around it — e.g. 'meeting about "Project X"
// 3pm' → "meeting about Project X", and 'Friday 11-1115 "1733 on Sale"' →
// "1733 on Sale" (the rest was all date/time).
const QUOTE_TOKEN_PREFIX = "ZZQUOTEDSPANZZ";

function protectQuotedSpans(query: string): { query: string; quotes: string[] } {
  const quotes: string[] = [];
  const out = query.replace(/(["“”])([^"“”]+)(["“”])/g, (_m, _o, inner) => {
    const token = `${QUOTE_TOKEN_PREFIX}${quotes.length}`;
    quotes.push(inner.trim());
    return token;
  });
  return { query: out, quotes };
}

function restoreQuotedSpans(text: string, quotes: string[]): string {
  let out = text;
  // Restore highest index first so token "…ZZ1" doesn't corrupt "…ZZ10". Use a
  // replacer function so "$"/"$&" in the quoted content aren't treated as
  // replacement metacharacters.
  for (let i = quotes.length - 1; i >= 0; i--) {
    out = out.replace(new RegExp(`${QUOTE_TOKEN_PREFIX}${i}`, "g"), () => quotes[i]);
  }
  return out;
}

// Day-of-week / month vocab reused for title stripping.
const DAY_NAMES_SRC =
  "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?";
const MONTHS_SRC =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Derive the event title from the leftover query (after all structured
// extractors have run, before preprocessing/Sherlock). We remove ONLY
// recognized date/time grammar and keep everything else — the opposite of
// Sherlock's eventTitle, which truncates at the first preposition and drops
// legitimate title words like "on Sale".
//
// `timeSpans` are the exact original substrings that preprocessQuery recognized
// as time ranges (e.g. "11-1115"); removing those keeps this in lockstep with
// the heuristics that actually parsed the times.
function deriveTitle(base: string, timeSpans: string[]): string | null {
  let title = base;

  // 1. Remove exact time-range spans that preprocessing recognized as times.
  //    Longest-first so "11-1115" is removed before any sub-span.
  for (const span of [...timeSpans].sort((a, b) => b.length - a.length)) {
    title = title.replace(new RegExp(`\\b${escapeRegExp(span)}`, "g"), " ");
  }

  const dateTimePatterns: RegExp[] = [
    // "from 9 to 10", "from 9am to 10:30pm" (Sherlock-style explicit range)
    /\bfrom\s+\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?\s+to\s+\d{1,2}(?::\d{2})?\s*(?:[ap]\.?m\.?)?/gi,
    // Compact meridian time: "630pm", "1230am" (3-4 bare digits + am/pm)
    /(?:\bat\s+|@\s*)?\b\d{3,4}\s*[ap]\.?m\.?\b/gi,
    // Single meridian time: "3pm", "at 3pm", "@3:30 p.m."
    /(?:\bat\s+|@\s*)?\b\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?\b/gi,
    // Relative offset: "in 30 minutes", "in 2 hours"
    /\bin\s+\d+\s*(?:min(?:ute)?s?|hrs?|h(?:ou)?rs?)\b/gi,
    // 24h colon time: "at 14:00", "15:30"
    /(?:\bat\s+|@\s*)?\b(?:[01]?\d|2[0-3]):[0-5]\d\b/gi,
    // EU time: "14h", "14h30", "9u30"
    /\b(?:[01]?\d|2[0-3])[uh](?:[0-5]\d)?\b/gi,
    // "at 3" (bare hour after "at") — but NOT when followed by a capitalized word
    // or another digit, which signals a venue/address ("dinner at 5 Guys",
    // "at 100 Congress"), not a time.
    /\bat\s+\d{1,2}\b(?!\s*[:-])(?!\s+[A-Z0-9])/g,
    // Relative dates
    /\b(?:day\s+(?:after|before)\s+)?(?:today|tod|tomorrow|tmrw|tom|tonight|yesterday|yest|now|right\s+now)\b/gi,
    // next/last/this week|month|year
    /\b(?:next|last|this)\s+(?:week|month|year)\b/gi,
    // Weekday, optionally led by an ordinal ("third thursday") and/or on/next/this
    new RegExp(
      `\\b(?:(?:first|second|third|fourth|fifth|last)\\s+)?(?:on\\s+|next\\s+|this\\s+)?(?:${DAY_NAMES_SRC})\\b`,
      "gi",
    ),
    // Month + day (+ optional year): "Jan 3", "on December 5th, 2027"
    new RegExp(`\\b(?:on\\s+)?(?:${MONTHS_SRC})\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?\\b`, "gi"),
    // Numeric date: "3/5", "12/25/2026"
    /\b(?:on\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/gi,
    // Time-of-day keywords (expandTimeKeywords turns these into times)
    /\b(?:in\s+the\s+)?(?:morning|afternoon|evening|midnight)\b/gi,
    // "noon"/"night" only when clearly temporal (avoid eating title words rarely,
    // but these are almost always times in this context)
    /\b(?:at\s+)?(?:noon|midday)\b/gi,
  ];

  for (const pattern of dateTimePatterns) {
    title = title.replace(pattern, " ");
  }

  // Strip a trailing standalone ordinal day-of-month ("payroll monthly 1st" →
  // "payroll"): only at the end, so a leading "5th anniversary" is preserved.
  title = title.replace(/\s+\d{1,2}(?:st|nd|rd|th)\s*$/i, "");

  // Trim connective words and stray punctuation orphaned by removals, at the
  // string edges only, so we never touch legitimate interior prepositions
  // (e.g. "Coffee on Sale") or interior punctuation.
  title = title
    .replace(/\s+/g, " ")
    .replace(/^(?:(?:on|at|from|to|for|in|by)\b\s*|[@,\-–—:.!;=]\s*)+/i, "")
    .replace(/(?:\s*\b(?:on|at|from|to|for|in|by)\b|\s*[@,\-–—:.!;=])+$/i, "")
    .trim();

  return title || null;
}

// ============= Main Parser =============

export function parseQuickEvent(
  searchText: string,
  calendars: CalendarInfo[],
  calendarNames: string[],
): ParsedQuickEvent | null {
  if (!searchText.trim()) return null;

  let query = searchText;

  // Collect the exact substrings that get consumed as date/time so the title
  // deriver can strip precisely those (and nothing more).
  const consumedTimeSpans: string[] = [];

  // Protect double-quoted spans as opaque tokens so nothing parses or strips
  // their contents; restored verbatim into the title at the end.
  const { query: queryWithoutQuotes, quotes } = protectQuotedSpans(query);
  query = queryWithoutQuotes;

  // Extract URLs BEFORE notes: a URL contains "//", which the notes extractor
  // would otherwise capture, swallowing everything after the link.
  const { query: queryWithoutUrls, urls } = extractUrls(query);
  query = queryWithoutUrls;

  // Extract notes (// at end)
  const { query: queryWithoutNotes, description } = extractNotes(query);
  query = queryWithoutNotes;

  // Extract calendar selector (/work, /personal, etc.)
  let matchedCalendar: string | undefined;
  let matchedCalendarColor: string | undefined;
  const calendarMatch = query.match(/\s\/([^\s/]+)\s*$/);
  if (calendarMatch) {
    const calendarInput = calendarMatch[1];
    matchedCalendar = matchCalendar(calendarInput, calendarNames);
    if (matchedCalendar) {
      const cal = calendars.find((c) => c.name === matchedCalendar);
      matchedCalendarColor = cal?.color;
    }
    query = query.slice(0, calendarMatch.index).trim();
  }

  // Extract attendees BEFORE location (to avoid matching email domains as locations)
  const { query: queryWithoutAttendees, attendees } = extractAttendees(query);
  query = queryWithoutAttendees;

  // Extract location (@location)
  const { query: queryWithoutLocation, location } = extractLocation(query);
  query = queryWithoutLocation;

  // Extract show as (~free, ~busy)
  const { query: queryWithoutShowAs, showAs } = extractShowAs(query);
  query = queryWithoutShowAs;

  // Extract alert/reminder
  const { query: queryWithoutAlert, alertMinutes } = extractAlert(query);
  query = queryWithoutAlert;

  // Extract duration (=30m, =1h, =allday)
  const { query: queryWithoutDuration, durationMs, isAllDay: durationIsAllDay } = extractDuration(query);
  query = queryWithoutDuration;

  // Extract "for X" duration (for 30 min, for 1 hour)
  const { query: queryWithoutForDuration, durationMs: forDurationMs } = extractForDuration(query);
  query = queryWithoutForDuration;
  const finalDurationMs = durationMs ?? forDurationMs;

  // Extract event type (OOO, focus time, etc.)
  const {
    query: queryWithoutEventType,
    eventType: rawEventType,
    eventTypeLabel: rawEventTypeLabel,
  } = extractEventType(query);
  query = queryWithoutEventType;

  // Extract recurrence (every day, every Monday, weekly, etc.)
  const {
    query: queryWithoutRecurrence,
    recurrence,
    recurrenceLabel,
    dayOfWeek: recurrenceDayOfWeek,
  } = extractRecurrence(query);
  query = queryWithoutRecurrence;

  // Extended recurrence (every other week, biweekly, every N weeks). Done here —
  // before the title base is captured — so the phrase is stripped from the title.
  let finalRecurrence = recurrence;
  let finalRecurrenceLabel = recurrenceLabel;
  if (!finalRecurrence) {
    const { query: queryWithoutExtended, recurrence: extRec, recurrenceLabel: extLabel } =
      extractExtendedRecurrence(query);
    if (extRec) {
      finalRecurrence = extRec;
      finalRecurrenceLabel = extLabel;
      query = queryWithoutExtended;
    }
  }
  const finalRecurrenceDayOfWeek = recurrenceDayOfWeek;

  // Extract multi-day date range (Dec 26 - Jan 2, Mon-Fri, etc.)
  const { query: queryWithoutDateRange, startDate: rangeStart, endDate: rangeEnd } = extractDateRange(query);
  query = queryWithoutDateRange;

  // Extract timezone (records the consumed time substring, e.g. "930" in "930 EST")
  const { query: queryWithoutTz, timezone, offsetMinutes } = extractTimezone(query, consumedTimeSpans);
  query = queryWithoutTz;

  // `query` is now the title base + any date/time Sherlock will parse.
  // Capture it (original casing) before preprocessing mangles it, so we can
  // derive the title ourselves rather than trusting Sherlock's lossy eventTitle.
  const titleBase = query;

  // Preprocess: expand time keywords and handle time formats
  let preprocessed = expandTimeKeywords(query);
  preprocessed = preprocessQuery(preprocessed, consumedTimeSpans);
  const parsed = Sherlock.parse(preprocessed);

  // Use date range if found, otherwise use Sherlock parsed dates
  let startDate = rangeStart ?? parsed.startDate ?? getDefaultStartDate();
  let endDate = rangeEnd ?? parsed.endDate ?? getDefaultEndDate(startDate);
  let isAllDay = rangeStart !== null || durationIsAllDay || parsed.isAllDay;

  // Handle overnight time ranges (e.g., 9pm-2am means 2am is next day)
  if (!isAllDay && endDate <= startDate && parsed.endDate) {
    // End time is before or equal to start time, assume it's the next day
    endDate = new Date(endDate.getTime() + 24 * 60 * 60 * 1000);
  }

  // Apply duration if specified (overrides parsed end date, but not date range)
  const effectiveDurationMs = finalDurationMs ?? (durationMs || undefined);
  if (effectiveDurationMs && !rangeStart) {
    endDate = new Date(startDate.getTime() + effectiveDurationMs);
    isAllDay = false;
  }

  // Apply timezone (not for all-day events)
  if (offsetMinutes !== null && !isAllDay) {
    startDate = applyTimezone(startDate, offsetMinutes);
    endDate = applyTimezone(endDate, offsetMinutes);
  }

  // Adjust past dates. Skip for explicit multi-day ranges and explicit "yesterday".
  // A clock time that has already passed TODAY rolls forward one DAY (matching
  // Sherlock's single-time behavior) — NOT a whole year, which is the old bug for
  // time ranges like "9-5". Only a genuinely earlier calendar date rolls to next
  // year. An explicit "today"/"tonight" keeps the event on today even if just past.
  const hasExplicitPastDate = /\byesterday\b/i.test(searchText);
  const wantsToday = /\b(today|tonight|tod)\b/i.test(searchText);
  if (!rangeStart && !hasExplicitPastDate) {
    const now = new Date();
    if (isAllDay) {
      const adjusted = adjustPastDate(startDate, true);
      if (adjusted.getTime() !== startDate.getTime()) {
        startDate = adjusted;
        endDate = addYears(endDate, 1);
      }
    } else if (startDate < now) {
      const spanMs = endDate.getTime() - startDate.getTime();
      if (isSameDay(startDate, now)) {
        if (!wantsToday) {
          startDate = addDays(startDate, 1);
          endDate = new Date(startDate.getTime() + spanMs);
        }
      } else {
        startDate = addYears(startDate, 1);
        endDate = new Date(startDate.getTime() + spanMs);
      }
    }
  }

  // If we have a specific day of week from recurrence (e.g., "every Tuesday"),
  // adjust the start date to the next occurrence of that day
  if (finalRecurrenceDayOfWeek !== undefined && !rangeStart) {
    const currentDayOfWeek = startDate.getDay();
    let daysToAdd = finalRecurrenceDayOfWeek - currentDayOfWeek;
    if (daysToAdd < 0) daysToAdd += 7;
    if (daysToAdd === 0 && startDate < new Date()) daysToAdd = 7; // If it's today but past, go to next week

    if (daysToAdd > 0) {
      const duration = endDate.getTime() - startDate.getTime();
      startDate = new Date(startDate);
      startDate.setDate(startDate.getDate() + daysToAdd);
      endDate = new Date(startDate.getTime() + duration);
    }
  }

  // Google Calendar API doesn't support recurring OOO/Focus Time events
  // Convert them to regular events when recurrence is specified
  let eventType = rawEventType;
  let eventTypeLabel = rawEventTypeLabel;

  // Derive the title: strip recognized date/time grammar from the leftover and
  // keep the rest, then restore protected tokens and quoted spans (verbatim).
  let eventTitle: string | null = deriveTitle(titleBase, consumedTimeSpans);
  if (eventTitle) {
    eventTitle = restoreQuotedSpans(
      eventTitle
        .replace(new RegExp(ONE_ON_ONE_TOKEN, "g"), "1-on-1")
        .replace(new RegExp(HYPHEN_TOKEN, "g"), "-")
        .replace(new RegExp(AND_TOKEN, "g"), "and"),
      quotes,
    )
      .replace(/\s+/g, " ")
      .trim();
    if (!eventTitle) eventTitle = null;
  }

  let apiLimitationWarning: string | undefined;

  if (finalRecurrence && (rawEventType === "outOfOffice" || rawEventType === "focusTime")) {
    eventType = "default";
    eventTypeLabel = undefined;
    // Preserve a meaningful title when converting from OOO/Focus
    if (!eventTitle) {
      eventTitle = rawEventType === "outOfOffice" ? "Out of office" : "Focus time";
    }
    // Add warning about API limitation
    const typeName = rawEventType === "outOfOffice" ? "OOO" : "Focus Time";
    apiLimitationWarning = `Recurring ${typeName} not supported by API`;
  }

  return {
    id: nanoid(),
    eventTitle,
    startDate,
    endDate,
    isAllDay,
    matchedCalendar,
    matchedCalendarColor,
    timezone: timezone ?? undefined,
    eventType,
    eventTypeLabel,
    durationMs: effectiveDurationMs,
    recurrence: finalRecurrence ?? undefined,
    recurrenceLabel: finalRecurrenceLabel,
    recurrenceDayOfWeek: finalRecurrenceDayOfWeek,
    location,
    description,
    urls,
    showAs,
    attendees,
    alertMinutes,
    apiLimitationWarning,
  };
}
