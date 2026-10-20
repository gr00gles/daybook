// Parses an iCalendar (.ics) feed off the main thread and expands recurring events into
// concrete occurrences between `from` and `to` (epoch ms).
importScripts('../lib/ical.min.js');

const JOIN =
  /https:\/\/(?:[\w-]+\.)*(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|webex\.com|whereby\.com|meet\.jit\.si|facetime\.apple\.com)\/[^\s"'<>)\]]+/i;

self.onmessage = ({ data }) => {
  try {
    self.postMessage({ id: data.id, events: expand(data.text, data.from, data.to) });
  } catch (err) {
    self.postMessage({ id: data.id, error: `Couldn't read this calendar file (${err?.message || err})` });
  }
};

function toMs(time) {
  if (time.isDate) return new Date(time.year, time.month - 1, time.day).getTime();
  return time.toJSDate().getTime();
}

const str = (v) => (v == null ? '' : String(v));

function occurrence(item, startTime, endTime, recurrenceId) {
  const comp = item.component;
  if (str(comp.getFirstPropertyValue('status')).toUpperCase() === 'CANCELLED') return null;
  const allDay = startTime.isDate;
  const start = toMs(startTime);
  let end = endTime ? toMs(endTime) : start;
  if (allDay && end <= start) end = start + 86400000;
  const location = str(item.location);
  const description = str(item.description);
  const join = (location + '\n' + str(comp.getFirstPropertyValue('url')) + '\n' + description).match(JOIN);
  return {
    id: `${item.uid}|${recurrenceId ? recurrenceId.toString() : start}`,
    title: str(item.summary).trim() || '(No title)',
    start,
    end,
    allDay,
    location: location.trim().slice(0, 140),
    join: join ? join[0] : '',
    notes: description.trim().slice(0, 2000),
  };
}

function expand(text, from, to) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const tz of root.getAllSubcomponents('vtimezone')) {
    try {
      ICAL.TimezoneService.register(tz);
    } catch {}
  }
  const masters = new Map();
  const loose = [];
  const exceptions = [];
  for (const vevent of root.getAllSubcomponents('vevent')) {
    if (vevent.hasProperty('recurrence-id')) exceptions.push(vevent);
    else {
      const ev = new ICAL.Event(vevent);
      if (masters.has(ev.uid)) loose.push(ev);
      else masters.set(ev.uid, ev);
    }
  }
  for (const vevent of exceptions) {
    const master = masters.get(str(vevent.getFirstPropertyValue('uid')));
    if (master && master.isRecurring()) master.relateException(vevent);
    else loose.push(new ICAL.Event(vevent));
  }

  const out = [];
  const keep = (o) => o && o.end > from && o.start < to && out.push(o);
  const horizon = to + 2 * 86400000;
  for (const ev of [...masters.values(), ...loose]) {
    if (!ev.startDate) continue;
    if (!ev.isRecurring()) {
      keep(occurrence(ev, ev.startDate, ev.endDate));
      continue;
    }
    const it = ev.iterator();
    let next;
    let guard = 0;
    while ((next = it.next()) && guard++ < 50000) {
      if (toMs(next) > horizon) break;
      const d = ev.getOccurrenceDetails(next);
      keep(occurrence(d.item, d.startDate, d.endDate, d.recurrenceId));
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
