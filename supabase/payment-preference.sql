-- IOYA: choose a preferred payment app on your profile.
-- Paste into Supabase → SQL Editor → New query → Run. Safe to run more than once.
-- Run profile-payment-accounts.sql first (on our shared project it was run on 2026-11-09).
--
-- Your payment accounts (Venmo, PayPal, Zelle, Cash App, Apple Cash) are saved by
-- save_my_payment_accounts() in profile_payment_accounts.accounts. This adds which of them you'd
-- most like to be paid with. The app tries it first when it prepares payment requests, and shows it
-- at the top of your payment accounts with a star.
--
-- A preference only counts while that account is still linked: if you remove your Venmo account,
-- get_my_payment_preference() stops returning 'venmo' (no clean-up needed).

-- 1. The column: one of the five app keys, or NULL for no preference.
ALTER TABLE public.profile_payment_accounts ADD COLUMN IF NOT EXISTS preferred text;
ALTER TABLE public.profile_payment_accounts DROP CONSTRAINT IF EXISTS profile_payment_accounts_preferred_check;
ALTER TABLE public.profile_payment_accounts ADD CONSTRAINT profile_payment_accounts_preferred_check
  CHECK (preferred IN ('venmo', 'paypal', 'zelle', 'cashapp', 'applecash'));

-- 2. Read your preference (NULL if none, or if that account is no longer linked).
CREATE OR REPLACE FUNCTION public.get_my_payment_preference()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT preferred FROM public.profile_payment_accounts
   WHERE user_id = public.app_user_id() AND accounts ? preferred;
$$;

-- 3. Set or clear it. The account must already be saved.
CREATE OR REPLACE FUNCTION public.set_my_payment_preference(p_method text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id constant integer := public.app_user_id();
  v_method  constant text := nullif(btrim(coalesce(p_method, '')), '');
  v_label   text;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Your account is not set up yet. Refresh and try again.';
  END IF;
  IF v_method IS NULL THEN
    UPDATE public.profile_payment_accounts SET preferred = NULL WHERE user_id = v_user_id;
    RETURN NULL;
  END IF;
  v_label := CASE v_method WHEN 'venmo' THEN 'Venmo' WHEN 'paypal' THEN 'PayPal' WHEN 'zelle' THEN 'Zelle'
                           WHEN 'cashapp' THEN 'Cash App' WHEN 'applecash' THEN 'Apple Cash' END;
  IF v_label IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Choose Venmo, PayPal, Zelle, Cash App or Apple Cash.';
  END IF;
  UPDATE public.profile_payment_accounts SET preferred = v_method
   WHERE user_id = v_user_id AND accounts ? v_method;
  IF NOT FOUND THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Add your ' || v_label || ' account before making it your preferred app.';
  END IF;
  RETURN v_method;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_payment_preference(), public.set_my_payment_preference(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_payment_preference(), public.set_my_payment_preference(text) TO authenticated;
