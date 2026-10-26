'use client';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

type Option = { id: string; name: string; group: { id: string; name: string } };
type View = {
  options: Option[];
  selected: Option | null;
  revision: number;
  invalidated: boolean;
};
export function TenantContext({ csrf }: { csrf: string }) {
  const [view, setView] = useState<View>();
  const [candidate, setCandidate] = useState('');
  const [problem, setProblem] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const changing = useRef(false);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const response = await fetch('/auth/context', { cache: 'no-store' });
      if (!response.ok) throw new Error('Unavailable');
      const next = (await response.json()) as View;
      if (generation.current !== request) return;
      setView(next);
      setCandidate(next.selected?.id ?? next.options[0]?.id ?? '');
    } catch {
      if (generation.current !== request) return;
      setView(undefined);
      setProblem(
        'No se pudo verificar el contexto. Reintentá antes de continuar.',
      );
    }
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
    const requests = generation;
    const check = () => {
      if (!changing.current && document.visibilityState === 'visible')
        void load();
    };
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', check);
    document.addEventListener('visibilitychange', check);
    return () => {
      requests.current++;
      window.removeEventListener('focus', check);
      window.removeEventListener('pageshow', check);
      document.removeEventListener('visibilitychange', check);
    };
  }, [load]);
  async function change(event: FormEvent<HTMLFormElement>, clear = false) {
    event.preventDefault();
    if (!view || changing.current) return;
    changing.current = true;
    generation.current++;
    setBusy(true);
    setProblem(undefined);
    try {
      const body = new URLSearchParams({
        csrf,
        revision: String(view.revision),
      });
      if (!clear) body.set('tenantId', candidate);
      const response = await fetch(
        clear ? '/auth/context/clear' : '/auth/context/select',
        { method: 'POST', body, cache: 'no-store' },
      );
      if (!response.ok)
        setProblem(
          response.status === 409
            ? 'La selección cambió en otra solicitud. Revisá y elegí nuevamente.'
            : 'No se pudo seleccionar esa organización. Revisá las opciones disponibles.',
        );
      await load();
    } catch {
      setView(undefined);
      setProblem(
        'No se pudo verificar el contexto. Reintentá antes de continuar.',
      );
    } finally {
      changing.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="tenant-context-title">
      <h2 id="tenant-context-title">Contexto organizacional</h2>
      <p>
        Esta selección es una preferencia de navegación. No concede permisos
        empresariales.
      </p>
      {problem && <p role="alert">{problem}</p>}
      {!view ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setProblem(undefined);
            void load();
          }}
        >
          Verificar organizaciones
        </button>
      ) : (
        <>
          {view.invalidated && (
            <p role="status">
              La organización seleccionada dejó de estar disponible. Elegí otra.
            </p>
          )}
          <p aria-live="polite">
            {view.selected
              ? `Organización seleccionada: ${view.selected.name}`
              : 'Sin organización seleccionada.'}
          </p>
          {!view.options.length ? (
            <p>No tenés organizaciones disponibles.</p>
          ) : (
            <form onSubmit={(event) => void change(event)}>
              <label htmlFor="tenant-choice">Organización disponible</label>{' '}
              <select
                id="tenant-choice"
                value={candidate}
                onChange={(event) => setCandidate(event.target.value)}
                disabled={busy}
              >
                {view.options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} — {option.group.name}
                  </option>
                ))}
              </select>{' '}
              <button type="submit" disabled={busy || !candidate}>
                Seleccionar organización
              </button>
            </form>
          )}
          {view.selected && (
            <form onSubmit={(event) => void change(event, true)}>
              <button type="submit" disabled={busy}>
                Limpiar selección
              </button>
            </form>
          )}
        </>
      )}
    </section>
  );
}
