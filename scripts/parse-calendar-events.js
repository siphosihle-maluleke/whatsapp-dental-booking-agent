/**
 * Parses Google Calendar event descriptions to extract patient contact info
 * and formats appointment timestamps for South African Standard Time (SAST).
 */
function parseCalendarEvents(events) {
  const results = [];

  for (const event of events) {
    const description = event.description || "";
    const phoneMatch = description.match(/Phone:\s*([+\d\s()-]+)/i);
    const nameMatch = description.match(/Client:\s*(.+)/i);

    if (!phoneMatch) continue;

    const phone = phoneMatch[1].trim();
    if (!phone) continue;

    const firstName = nameMatch ? nameMatch[1].trim().split(/\s+/)[0] : "there";
    const startRaw = event.start?.dateTime || event.start?.date;

    const formattedTime = startRaw
      ? new Date(startRaw).toLocaleTimeString("en-ZA", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Africa/Johannesburg",
        })
      : "your scheduled time";

    results.push({ phone, name: firstName, time: formattedTime });
  }

  return results;
}

module.exports = { parseCalendarEvents };