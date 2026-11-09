-- Apply after the manual payment migrations. Safe to re-run.
CREATE OR REPLACE FUNCTION public.valid_manual_payment_account(
  p_method text, p_value text, p_consent boolean
) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $account$
  SELECT coalesce(
    CASE WHEN char_length(p_value) > CASE WHEN p_method = 'applePayUrl' THEN 1000 ELSE 100 END THEN false
    WHEN p_method = 'venmo' THEN p_value ~ '^[A-Za-z0-9_-]{5,30}$'
    WHEN p_method = 'paypal' AND p_value ~ '^[A-Za-z0-9]{1,20}$' THEN true
    WHEN (p_method = 'zelle' OR (p_method IN ('cashapp', 'applecash') AND NOT p_consent))
      AND p_value ~ '^\+1[2-9][0-9]{9}$' THEN true
    WHEN p_method = 'cashapp' AND NOT p_consent
      AND p_value ~ '^\$[A-Za-z0-9]{1,20}$' AND p_value ~ '[A-Za-z]' THEN true
    WHEN p_method IN ('zelle', 'paypal') OR (p_method = 'cashapp' AND NOT p_consent)
      THEN p_value ~* $pattern$^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}$$pattern$
    WHEN p_method = 'applePayUrl' AND NOT p_consent
      THEN p_value ~ '^https://(buy|checkout)\.stripe\.com/[A-Za-z0-9_/-]+(#[A-Za-z0-9%=_-]+)?$'
    ELSE false END, false);
$account$;

REVOKE ALL ON FUNCTION public.valid_manual_payment_account(text, text, boolean) FROM PUBLIC, anon, authenticated;
