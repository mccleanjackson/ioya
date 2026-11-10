-- IOYA: profile pictures.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run private-data.sql first (it already has been on our shared project).
--
-- How it works:
-- * Photos live in a Supabase Storage bucket called "avatars". The app shrinks each photo to a
--   400×400 JPEG (about 50 KB) before uploading, and the bucket refuses anything that isn't a JPEG
--   or is over 1 MB.
-- * Only saved profiles (signed in with an email) can add a photo; guests can't. Supabase marks guest
--   logins with is_anonymous = true in the login token (auth.jwt()), and the upload rules and
--   set_my_avatar() both check it.
-- * Each profile uploads into its own folder, named after its Supabase Auth ID:
--   avatars/<auth user id>/<random name>.jpg. The policies below let people add, replace and delete
--   files only in their own folder.
-- * The bucket is public: anyone with a photo's exact link can view it (the profile QR page will need
--   this). The random file names mean no one can guess links, and nobody can list other people's files.
-- * users.avatar_path stores which file is the current photo. The app changes it only through
--   set_my_avatar(), which checks that the file is in the caller's own folder and really exists.

-- 1. The bucket.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('avatars', 'avatars', true, 1048576, ARRAY['image/jpeg'])
ON CONFLICT (id) DO UPDATE
  SET public = true, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 2. Who can do what with the files. Uploading, replacing and deleting need these policies; viewing a
--    photo through its public link does not (that's what "public" means), so SELECT is limited to your
--    own folder and nobody can list everyone's photos.
DROP POLICY IF EXISTS "Avatars: see own files" ON storage.objects;
CREATE POLICY "Avatars: see own files" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

DROP POLICY IF EXISTS "Avatars: upload to own folder" ON storage.objects;
CREATE POLICY "Avatars: upload to own folder" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
              AND (SELECT (auth.jwt() ->> 'is_anonymous')::boolean) IS FALSE);

DROP POLICY IF EXISTS "Avatars: replace own files" ON storage.objects;
CREATE POLICY "Avatars: replace own files" ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text)
  WITH CHECK (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text
              AND (SELECT (auth.jwt() ->> 'is_anonymous')::boolean) IS FALSE);

DROP POLICY IF EXISTS "Avatars: delete own files" ON storage.objects;
CREATE POLICY "Avatars: delete own files" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'avatars' AND (storage.foldername(name))[1] = (SELECT auth.uid())::text);

-- 3. Which file is the current photo (NULL = no photo, show initials).
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_path text;

-- 4. Set or clear your photo. Returns the previous path so the app can delete the old file.
--    Clearing (NULL) is always allowed; setting a photo needs a saved profile.
CREATE OR REPLACE FUNCTION set_my_avatar(p_path text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_user_id  constant integer := app_user_id();
  v_path     constant text := nullif(trim(coalesce(p_path, '')), '');
  v_old      text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Your account isn''t set up yet. Refresh the page and try again.';
  END IF;
  IF v_path IS NOT NULL THEN
    IF (SELECT (auth.jwt() ->> 'is_anonymous')::boolean) IS NOT FALSE THEN
      RAISE EXCEPTION 'Create a profile to add a profile picture.';
    END IF;
    -- Must be <your auth id>/<random name>.jpg, and the upload must have finished.
    IF v_path !~ ('^' || (SELECT auth.uid())::text || '/[A-Za-z0-9-]{8,64}\.jpg$') THEN
      RAISE EXCEPTION 'That photo can''t be used. Choose the photo again.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'avatars' AND name = v_path) THEN
      RAISE EXCEPTION 'The photo upload didn''t finish. Choose the photo again.';
    END IF;
  END IF;

  SELECT avatar_path INTO v_old FROM users WHERE user_id = v_user_id FOR UPDATE;
  UPDATE users SET avatar_path = v_path WHERE user_id = v_user_id;
  RETURN v_old;
END $$;

REVOKE ALL ON FUNCTION set_my_avatar(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION set_my_avatar(text) TO authenticated;
