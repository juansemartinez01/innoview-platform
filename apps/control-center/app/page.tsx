'use client';
import { useEffect, useState } from 'react';
type Session = {
  authenticated: boolean;
  csrf: string;
  identity?: { id: string; subject: string; issuer: string };
};
export default function Home() {
  const [session, setSession] = useState<Session>();
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch('/auth/session', { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Unavailable');
        setSession(await response.json());
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, []);
  return (
    <main
      style={{
        maxWidth: 640,
        margin: '64px auto',
        padding: 24,
        fontFamily: 'system-ui',
      }}
    >
      <h1>Control Center Innoview</h1>
      <p>Identidad centralizada de Innoview Platform.</p>
      <p>
        Pantalla técnica. Autenticarse no concede privilegios de administración.
      </p>
      {error ? (
        <p role="alert">
          No se pudo verificar la sesión. Recargá para reintentar.
        </p>
      ) : !session ? (
        <p>Verificando sesión…</p>
      ) : session.authenticated ? (
        <>
          <h2>Sesión iniciada</h2>
          <p>Identidad: {session.identity?.id}</p>
          <form method="post" action="/auth/logout">
            <input type="hidden" name="csrf" value={session.csrf} />
            <button type="submit">Cerrar sesión local</button>
            <button name="sso" value="true" type="submit">
              Cerrar sesión también en Keycloak
            </button>
          </form>
        </>
      ) : (
        <form method="post" action="/auth/login">
          <input type="hidden" name="csrf" value={session.csrf} />
          <button type="submit">Iniciar sesión</button>
        </form>
      )}
    </main>
  );
}
