-- ===========================================================================
-- Holiday calendar in English, as it is kept locally.
--
-- The data move kept the dates only Lintang's calendar had, under his
-- Indonesian names. They are renamed to match the local list: collective
-- leave as "Collective Leave: ...", national holidays by their English name.
-- Nothing is removed and no date or National flag changes.
--
-- Each row matches on date and the exact old name, so re-running this, or a
-- holiday already renamed in Settings, changes nothing.
-- ===========================================================================

begin;

update public.public_holidays h
   set name = v.new_name, updated_at = now()
  from (values
        ('2026-02-16'::date, 'Cuti Bersama Tahun Baru Imlek',          'Collective Leave: Chinese New Year'),
        ('2026-03-18'::date, 'Cuti Bersama Hari Suci Nyepi',           'Collective Leave: Nyepi'),
        ('2026-03-22'::date, 'Idul Fitri 1447 Hijriah',                'Eid al-Fitr 1447H'),
        ('2026-05-15'::date, 'Cuti Bersama Kenaikan Yesus Kristus',    'Collective Leave: Ascension'),
        ('2026-05-28'::date, 'Cuti Bersama Idul Adha',                 'Collective Leave: Eid al-Adha'),
        ('2026-12-24'::date, 'Cuti Bersama Hari Raya Natal',           'Collective Leave: Christmas'),
        ('2027-01-05'::date, 'Isra Mikraj Nabi Muhammad SAW 1448 H',   'Isra Mi''raj'),
        ('2027-02-05'::date, 'Cuti Bersama Tahun Baru Imlek',          'Collective Leave: Chinese New Year'),
        ('2027-02-06'::date, 'Tahun Baru Imlek 2578 Kongzili',         'Chinese New Year 2578'),
        ('2027-03-08'::date, 'Hari Suci Nyepi (Tahun Baru Saka 1949)', 'Nyepi (Saka New Year 1949)'),
        ('2027-03-09'::date, 'Cuti Bersama Idul Fitri',                'Collective Leave: Eid al-Fitr'),
        ('2027-03-10'::date, 'Idul Fitri 1448 Hijriah',                'Eid al-Fitr 1448H'),
        ('2027-03-11'::date, 'Idul Fitri 1448 Hijriah',                'Eid al-Fitr 1448H'),
        ('2027-03-12'::date, 'Cuti Bersama Idul Fitri',                'Collective Leave: Eid al-Fitr'),
        ('2027-03-15'::date, 'Cuti Bersama Idul Fitri',                'Collective Leave: Eid al-Fitr'),
        ('2027-03-25'::date, 'Cuti Bersama Wafat Yesus Kristus',       'Collective Leave: Good Friday'),
        ('2027-05-17'::date, 'Idul Adha 1448 Hijriah',                 'Eid al-Adha 1448H'),
        ('2027-05-18'::date, 'Cuti Bersama Idul Adha',                 'Collective Leave: Eid al-Adha'),
        ('2027-05-19'::date, 'Cuti Bersama Hari Raya Waisak',          'Collective Leave: Vesak Day'),
        ('2027-05-20'::date, 'Hari Raya Waisak 2571 BE',               'Vesak Day 2571'),
        ('2027-06-06'::date, 'Tahun Baru Islam 1449 Hijriah',          'Islamic New Year 1449H'),
        ('2027-08-15'::date, 'Maulid Nabi Muhammad SAW',               'Prophet Muhammad''s Birthday'),
        ('2027-12-24'::date, 'Cuti Bersama Hari Raya Natal',           'Collective Leave: Christmas'),
        ('2027-12-26'::date, 'Isra Mikraj Nabi Muhammad SAW 1449 H',   'Isra Mi''raj')
       ) as v(date, old_name, new_name)
 where h.date = v.date and h.name = v.old_name;

commit;
