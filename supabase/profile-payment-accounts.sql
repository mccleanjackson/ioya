-- Save payer payment identifiers independently from the profile name and phone.
-- Apply after private-data.sql. Safe to run more than once.
CREATE TABLE IF NOT EXISTS public.profile_payment_accounts (
  user_id integer PRIMARY KEY REFERENCES public.users(user_id) ON DELETE CASCADE,
  accounts jsonb NOT NULL
);

ALTER TABLE public.profile_payment_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Read own profile payment accounts" ON public.profile_payment_accounts;
CREATE POLICY "Read own profile payment accounts" ON public.profile_payment_accounts
  FOR SELECT TO authenticated USING (user_id = (SELECT public.app_user_id()));
REVOKE ALL ON public.profile_payment_accounts FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.get_my_payment_accounts()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT coalesce((
    SELECT accounts FROM public.profile_payment_accounts WHERE user_id = public.app_user_id()
  ), '{}'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.save_my_payment_accounts(p_accounts jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_user_id constant integer := public.app_user_id();
  v_entry record;
  v_value text;
  v_email boolean;
  v_phone text;
  v_accounts jsonb := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42501', MESSAGE = 'Your account is not set up yet. Refresh and try again.';
  END IF;
  IF jsonb_typeof(p_accounts) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter valid payment account details.';
  END IF;

  FOR v_entry IN SELECT key, value FROM jsonb_each(p_accounts) LOOP
    IF v_entry.key NOT IN ('venmo', 'paypal', 'zelle', 'cashapp', 'applecash')
       OR jsonb_typeof(v_entry.value) IS DISTINCT FROM 'string' THEN
      RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter valid payment account details.';
    END IF;
    v_value := btrim(v_entry.value #>> '{}');
    IF v_value = '' THEN CONTINUE; END IF;
    v_email := length(v_value) <= 100 AND v_value ~* '^[a-z0-9.!#$%&''*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$';
    v_phone := NULL;
    IF length(v_value) <= 40 AND v_value ~ '^[0-9+().[:space:]-]+$' THEN
      v_phone := regexp_replace(v_value, '[^0-9]', '', 'g');
      v_phone := CASE
        WHEN v_phone ~ '^[2-9][0-9]{9}$' THEN '+1' || v_phone
        WHEN v_phone ~ '^1[2-9][0-9]{9}$' THEN '+' || v_phone
        ELSE NULL
      END;
    END IF;

    CASE v_entry.key
      WHEN 'venmo' THEN
        IF v_value !~ '^@?[A-Za-z0-9_-]{5,30}$' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter your Venmo username.';
        END IF;
        v_value := ltrim(v_value, '@');
      WHEN 'paypal' THEN
        IF NOT v_email AND v_value !~ '^[A-Za-z0-9]{1,20}$' THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter your PayPal email or PayPal.Me username.';
        END IF;
      WHEN 'zelle' THEN
        IF NOT v_email AND v_phone IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter your Zelle email or U.S. mobile number.';
        END IF;
        v_value := coalesce(v_phone, v_value);
      WHEN 'cashapp' THEN
        IF NOT v_email AND v_phone IS NULL
           AND NOT (v_value ~ '^\$[A-Za-z0-9]{1,20}$' AND v_value ~ '[A-Za-z]') THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter your Cash App $cashtag, email, or U.S. mobile number.';
        END IF;
        v_value := coalesce(v_phone, v_value);
      WHEN 'applecash' THEN
        IF v_phone IS NULL THEN
          RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'Enter your Apple Cash U.S. mobile number.';
        END IF;
        v_value := v_phone;
    END CASE;
    v_accounts := v_accounts || jsonb_build_object(v_entry.key, v_value);
  END LOOP;

  INSERT INTO public.profile_payment_accounts (user_id, accounts)
  VALUES (v_user_id, v_accounts)
  ON CONFLICT (user_id) DO UPDATE SET accounts = excluded.accounts;
  RETURN v_accounts;
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_payment_accounts(), public.save_my_payment_accounts(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_payment_accounts(), public.save_my_payment_accounts(jsonb) TO authenticated;
