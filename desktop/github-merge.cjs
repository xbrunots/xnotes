'use strict';
const crypto = require('node:crypto');

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => value === undefined ? 'undefined' : Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : plain(value) ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}' : JSON.stringify(value);
const same = (left, right) => canonical(left) === canonical(right);
const keyOf = record => record.kind + ':' + record.key;
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
function dominates(left, right) {
  let greater = false;
  for (const device of new Set([...Object.keys(left), ...Object.keys(right)])) {
    if ((left[device] || 0) < (right[device] || 0)) return false;
    if ((left[device] || 0) > (right[device] || 0)) greater = true;
  }
  return greater;
}
function heads(records) {
  const result = new Map();
  for (const record of records) {
    const key = keyOf(record), group = result.get(key) || [];
    if (group.some(head => head.id === record.id || dominates(head.clock, record.clock))) continue;
    result.set(key, group.filter(head => !dominates(record.clock, head.clock)).concat(record));
  }
  return result;
}
const winner = records => [...records].sort((a, b) => Number(a.deleted) - Number(b.deleted)
  || Math.max(...Object.values(a.clock)) - Math.max(...Object.values(b.clock)) || a.device.localeCompare(b.device, 'en') || a.id.localeCompare(b.id, 'en')).at(-1);
function ancestor(records, left, right) {
  return winner(records.filter(record => keyOf(record) === keyOf(left)
    && (record.id === left.id || dominates(left.clock, record.clock))
    && (record.id === right.id || dominates(right.clock, record.clock))));
}

// Fields changed on only one computer combine without asking the user. Arrays
// are atomic, except attachment descriptors, whose independently added files
// can be united without dropping a blob referenced by either side.
function mergeFields(base, local, remote, field = '') {
  if (same(local, remote)) return { value: clone(local) };
  if (same(local, base)) return { value: clone(remote) };
  if (same(remote, base)) return { value: clone(local) };
  if (field === 'attachments' && [base, local, remote].every(value => Array.isArray(value) || value === undefined)) {
    const fileKey = value => value.hash + ':' + value.relativePath + ':' + value.name;
    const maps = [base || [], local || [], remote || []].map(list => new Map(list.map(value => [fileKey(value), value])));
    const result = [];
    for (const key of new Set(maps.flatMap(map => [...map.keys()]))) {
      const merged = mergeFields(maps[0].get(key), maps[1].get(key), maps[2].get(key));
      if (merged.conflict) return merged;
      if (merged.value !== undefined) result.push(merged.value);
    }
    return { value: result };
  }
  if (plain(local) && plain(remote) && (plain(base) || base === undefined)) {
    const value = {};
    for (const key of new Set([...Object.keys(base || {}), ...Object.keys(local), ...Object.keys(remote)])) {
      const merged = mergeFields(base?.[key], local[key], remote[key], key);
      if (merged.conflict) return merged;
      if (merged.value !== undefined) Object.defineProperty(value, key, { value: merged.value, enumerable: true, writable: true, configurable: true });
    }
    return { value };
  }
  return { conflict: true };
}

async function mergeNote(base, local, remote, mergeText) {
  const withoutText = value => { const copy = clone(value); if (copy?.data) { delete copy.data.body; delete copy.data.richText; delete copy.data.t; } return copy; };
  const merged = mergeFields(withoutText(base), withoutText(local), withoutText(remote));
  if (merged.conflict) return merged;
  const pair = value => value?.data && { body: value.data.body, ...(own(value.data, 'richText') ? { richText: value.data.richText } : {}) };
  const [b, l, r] = [base, local, remote].map(pair);
  let text;
  if (same(l, r)) text = clone(l);
  else if (same(l, b)) text = clone(r);
  else if (same(r, b)) text = clone(l);
  else {
    if (!b || l.body === r.body) return { conflict: true };
    const body = await mergeText(b.body, l.body, r.body);
    if (body === null) return { conflict: true };
    // A document belongs to its exact Markdown source. A combined text is
    // rendered anew; a stale rich document must never hide merged paragraphs.
    text = { body };
    const matching = [l, r].find(value => value.body === body && value.richText?.source === body);
    if (matching) text.richText = clone(matching.richText);
  }
  Object.assign(merged.value.data, text);
  if (local.data.t !== undefined || remote.data.t !== undefined) merged.value.data.t = remote.data.t || local.data.t;
  return merged;
}

async function planRevisions(localRecords, remoteRecords, mergeText) {
  const records = [...new Map([...localRecords, ...remoteRecords].map(record => [record.id, record])).values()];
  const local = heads(localRecords), remote = heads(remoteRecords), resolutions = [], conflicts = [];
  for (const [key, versions] of heads(records)) {
    if (versions.length < 2) continue;
    const left = winner(local.get(key) || []), right = winner(remote.get(key) || []);
    if (!left || !right) throw new Error('O histórico contém cabeças concorrentes sem origem identificável.');
    if (left.deleted === right.deleted && same(left.value, right.value)) {
      resolutions.push({ kind: left.kind, key: left.key, choice: 'local' }); continue;
    }
    const base = ancestor(records, left, right);
    let merged = { conflict: true };
    if (!left.deleted && !right.deleted) merged = left.kind === 'note'
      ? await mergeNote(base?.deleted ? undefined : base?.value, left.value, right.value, mergeText)
      : mergeFields(base?.deleted ? undefined : base?.value, left.value, right.value);
    if (!merged.conflict) resolutions.push({ kind: left.kind, key: left.key, choice: 'merged', value: merged.value });
    else conflicts.push({ id: 'entity-' + crypto.createHash('sha256').update(key).digest('hex'), kind: left.kind, key: left.key,
      local: left, remote: right, ...(base ? { base } : {}) });
  }
  return { resolutions, conflicts, records };
}

module.exports = { heads, winner, ancestor, dominates, mergeFields, mergeNote, planRevisions, same, canonical, keyOf };
