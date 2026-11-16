-- IOYA: drag groups into your own order (Contacts tab).
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run after private-data.sql (friend_groups.user_id, app_user_id()).
--
-- friend_groups.position is each group's place in its owner's list (1 = first). New groups have no
-- position yet and show after the ordered ones (oldest first), the same order as before this file.
-- save_group_order(p_group_ids) saves a new order for the signed-in person's own groups.

ALTER TABLE friend_groups ADD COLUMN IF NOT EXISTS position integer;

-- p_group_ids is the full list in the new order, for example ARRAY[7, 3, 12]. Groups not in the list
-- (say, one just made in another tab) keep their order after the listed ones, so nothing is lost.
CREATE OR REPLACE FUNCTION save_group_order(p_group_ids integer[])
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id constant integer := app_user_id();
  v_ids     constant integer[] := coalesce(p_group_ids, '{}');
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Your account isn''t set up yet. Refresh the page and try again.';
  END IF;
  IF cardinality(v_ids) > 500 OR array_position(v_ids, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT id) FROM unnest(v_ids) AS id) <> cardinality(v_ids) THEN
    RAISE EXCEPTION 'That group order isn''t valid. Refresh the page and try again.';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(v_ids) AS id
              WHERE NOT EXISTS (SELECT 1 FROM friend_groups g WHERE g.group_id = id AND g.user_id = v_user_id)) THEN
    RAISE EXCEPTION 'One of those groups no longer exists. Refresh the page and try again.';
  END IF;

  UPDATE friend_groups g SET position = o.new_position
    FROM (SELECT f.group_id,
                 row_number() OVER (ORDER BY array_position(v_ids, f.group_id) NULLS LAST,
                                             f.position NULLS LAST, f.group_id) AS new_position
            FROM friend_groups f WHERE f.user_id = v_user_id) o
   WHERE g.group_id = o.group_id;
END $$;

REVOKE ALL ON FUNCTION save_group_order(integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_group_order(integer[]) TO authenticated;
