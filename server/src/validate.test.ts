// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 OpenMasjid-Solutions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normTimetable, normSettings } from './validate';
import type { Settings } from './types';

test('adhan delay offsets: clamped to 0–60, zeros omitted', () => {
  const tt = normTimetable({ adhanOffsets: { fajr: 5, dhuhr: 200, asr: 0, maghrib: -10 } });
  assert.equal(tt.adhanOffsets?.fajr, 5); // in range
  assert.equal(tt.adhanOffsets?.dhuhr, 60); // clamped to max
  assert.equal(tt.adhanOffsets?.asr, undefined); // zero omitted
  assert.equal(tt.adhanOffsets?.maghrib, undefined); // negative → 0 → omitted
});

test('adhan pop-up: seconds clamped to 3–120', () => {
  assert.equal(normTimetable({ adhanPopup: { enabled: true, seconds: 500 } }).adhanPopup?.seconds, 120);
  assert.equal(normTimetable({ adhanPopup: { enabled: true, seconds: 1 } }).adhanPopup?.seconds, 3);
  const off = normTimetable({ adhanPopup: { enabled: false, seconds: 15 } }).adhanPopup;
  assert.equal(off?.enabled, false);
  assert.equal(off?.seconds, 15);
});

test('hadith salah targeting: prayer keys sanitized + canonical order; empty override kept', () => {
  const sh = normTimetable({
    salahHadith: {
      enabled: true,
      minutes: 10,
      items: [{ ar: '', en: 'x', prayers: ['asr', 'bogus', 'fajr'] }],
      defaultPrayers: { 'miss-asr-family-property': [], foo: ['maghrib', 'junk'] },
    },
  }).salahHadith!;
  // invalid key dropped, order canonicalised (fajr before asr)
  assert.deepEqual(sh.items[0].prayers, ['fajr', 'asr']);
  // an explicit empty override is preserved (means "show after all prayers")
  assert.deepEqual(sh.defaultPrayers?.['miss-asr-family-property'], []);
  // junk key stripped from an override
  assert.deepEqual(sh.defaultPrayers?.foo, ['maghrib']);
});

// ── WhatsApp announcement settings ────────────────────────────────────────────

const WA_BASE: Settings = {
  defaultQuality: '1080p',
  scheduleTimezone: '',
  volunteerEnabled: false,
  volunteerRemote: true,
  whatsapp: { iqamahChange: false, groupId: '', groupLabel: '', timetableId: '', daysBefore: 1 },
  webScreensBeta: false,
};

test('WhatsApp posting is off, with no group, until an admin says otherwise', () => {
  const s = normSettings({}, WA_BASE);
  assert.equal(s.whatsapp.iqamahChange, false);
  assert.equal(s.whatsapp.groupId, '');
});

test('only a WhatsApp group JID is accepted as a group', () => {
  // The platform re-checks the id against the admin's approved list on every send, so this
  // is a shape check, not an authorisation one — it just keeps junk out of the store.
  const ok = normSettings({ whatsapp: { groupId: '120363012345678901@g.us' } }, WA_BASE);
  assert.equal(ok.whatsapp.groupId, '120363012345678901@g.us');

  for (const bad of ['+15550101234', '12345', 'not a jid', '120363012345678901@s.whatsapp.net', '<script>@g.us']) {
    assert.equal(normSettings({ whatsapp: { groupId: bad } }, WA_BASE).whatsapp.groupId, '', `rejected: ${bad}`);
  }
});

test('clearing the group clears its remembered name too', () => {
  const base: Settings = { ...WA_BASE, whatsapp: { ...WA_BASE.whatsapp, groupId: '120363012345678901@g.us', groupLabel: 'Announcements' } };
  const cleared = normSettings({ whatsapp: { groupId: '' } }, base);
  assert.equal(cleared.whatsapp.groupId, '');
  assert.equal(cleared.whatsapp.groupLabel, '', 'a caption pointing at nothing is worse than none');
});

test('the lead time is clamped to a fortnight, and 0 (the day itself) is allowed', () => {
  assert.equal(normSettings({ whatsapp: { daysBefore: 0 } }, WA_BASE).whatsapp.daysBefore, 0);
  assert.equal(normSettings({ whatsapp: { daysBefore: 400 } }, WA_BASE).whatsapp.daysBefore, 14);
  assert.equal(normSettings({ whatsapp: { daysBefore: -3 } }, WA_BASE).whatsapp.daysBefore, 0);
});

test('an absent whatsapp block keeps the current settings rather than wiping them', () => {
  // PUT /api/settings is a merge, and the panel's other sections do not send this block.
  const base: Settings = { ...WA_BASE, whatsapp: { iqamahChange: true, groupId: '120363012345678901@g.us', groupLabel: 'Announcements', timetableId: 't1', daysBefore: 5 } };
  const s = normSettings({ defaultQuality: '720p' }, base);
  assert.deepEqual(s.whatsapp, base.whatsapp);
});
