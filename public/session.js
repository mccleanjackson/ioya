/* IOYA login storage, shared by the landing page (/), the app (/app) and the admin pages (/admin).
   Supabase normally keeps the login in localStorage. We keep it in cookies instead, so "Log out"
   can remove the login cookies (a course requirement) and every page on this site shares one login.

   A Supabase login is about 2–3 KB, close to the 4 KB limit for one cookie, so it is split into
   pieces: <name>.0, <name>.1, … The pages pass IOYA_AUTH_OPTIONS to supabase.createClient(). */
(function () {
  const CHUNK = 3000;                                   // encoded characters per cookie piece (limit is ~4096)
  const YEAR = 60 * 60 * 24 * 365;                      // Supabase refreshes the login itself
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  const enc = s => encodeURIComponent(s);

  function cookieNames() {
    return document.cookie.split(';').map(c => c.trim().split('=')[0]).filter(Boolean).map(decodeURIComponent);
  }
  // Cookie values are stored URL-encoded; read and write them as they are.
  function readCookie(name) {
    const hit = document.cookie.split(';').map(c => c.trim()).find(c => c.startsWith(enc(name) + '='));
    return hit === undefined ? null : hit.slice(enc(name).length + 1);
  }
  function writeCookie(name, encodedValue, maxAge) {
    document.cookie = `${enc(name)}=${encodedValue}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure}`;
  }
  // Encode first, then cut into pieces, never in the middle of a %XX escape.
  function split(encoded) {
    const out = [];
    for (let i = 0; i < encoded.length; ) {
      let end = Math.min(i + CHUNK, encoded.length);
      if (end < encoded.length) { const p = encoded.lastIndexOf('%', end - 1); if (p > end - 3) end = p; }
      out.push(encoded.slice(i, end)); i = end;
    }
    return out.length ? out : [''];
  }
  const pieces = key => cookieNames().filter(n => n.startsWith(key + '.') && /^\d+$/.test(n.slice(key.length + 1)));

  const cookieStorage = {
    getItem(key) {
      const parts = [];
      for (let i = 0; ; i++) { const part = readCookie(`${key}.${i}`); if (part === null) break; parts.push(part); }
      if (parts.length) { try { return decodeURIComponent(parts.join('')); } catch (e) { return null; } }
      // Visitors from before this change have their login in localStorage: move it into cookies.
      try {
        const old = localStorage.getItem(key);
        if (old !== null) { cookieStorage.setItem(key, old); localStorage.removeItem(key); return old; }
      } catch (e) { /* localStorage blocked: nothing to move */ }
      return null;
    },
    setItem(key, value) {
      const parts = split(enc(value)), count = parts.length;
      parts.forEach((part, i) => writeCookie(`${key}.${i}`, part, YEAR));
      pieces(key).filter(n => Number(n.slice(key.length + 1)) >= count).forEach(n => writeCookie(n, '', 0));
    },
    removeItem(key) {
      pieces(key).forEach(n => writeCookie(n, '', 0));
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
  };

  window.IOYA_AUTH_OPTIONS = {auth: {storage: cookieStorage, persistSession: true, autoRefreshToken: true}};
  // Log out: delete every Supabase login cookie on this site (all pieces, any project).
  window.IOYA_CLEAR_LOGIN_COOKIES = () => cookieNames().filter(n => n.startsWith('sb-')).forEach(n => writeCookie(n, '', 0));
})();
