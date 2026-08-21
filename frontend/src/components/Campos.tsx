import { useId, type ReactNode, type SelectHTMLAttributes, type InputHTMLAttributes, type TextareaHTMLAttributes } from 'react';

/**
 * Campos de formulario accesibles: etiqueta asociada, ayuda y error vinculados
 * por `aria-describedby`, y estado invalido anunciado con `aria-invalid`.
 */

interface Comun {
  etiqueta: string;
  ayuda?: string;
  error?: string;
  obligatorio?: boolean;
  ancho?: boolean;
}

export function CampoTexto({
  etiqueta,
  ayuda,
  error,
  obligatorio,
  ancho,
  ...props
}: Comun & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  return (
    <div className={ancho ? 'campo campo--ancho' : 'campo'}>
      <label htmlFor={id}>
        {etiqueta}
        {obligatorio ? <span className="obligatorio" aria-hidden="true"> *</span> : null}
        {obligatorio ? <span className="solo-lectores"> (obligatorio)</span> : null}
      </label>
      <input
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={[ayuda ? idAyuda : null, error ? idError : null].filter(Boolean).join(' ') || undefined}
        aria-required={obligatorio || undefined}
        {...props}
      />
      {ayuda ? <span className="campo__ayuda" id={idAyuda}>{ayuda}</span> : null}
      {error ? <span className="campo__error" id={idError}>{error}</span> : null}
    </div>
  );
}

export function CampoSelect({
  etiqueta,
  ayuda,
  error,
  obligatorio,
  ancho,
  children,
  ...props
}: Comun & SelectHTMLAttributes<HTMLSelectElement> & { children: ReactNode }) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  return (
    <div className={ancho ? 'campo campo--ancho' : 'campo'}>
      <label htmlFor={id}>
        {etiqueta}
        {obligatorio ? <span className="obligatorio" aria-hidden="true"> *</span> : null}
      </label>
      <select
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={[ayuda ? idAyuda : null, error ? idError : null].filter(Boolean).join(' ') || undefined}
        {...props}
      >
        {children}
      </select>
      {ayuda ? <span className="campo__ayuda" id={idAyuda}>{ayuda}</span> : null}
      {error ? <span className="campo__error" id={idError}>{error}</span> : null}
    </div>
  );
}

export function CampoArea({
  etiqueta,
  ayuda,
  error,
  obligatorio,
  ancho = true,
  ...props
}: Comun & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  const idError = `${id}-error`;
  return (
    <div className={ancho ? 'campo campo--ancho' : 'campo'}>
      <label htmlFor={id}>
        {etiqueta}
        {obligatorio ? <span className="obligatorio" aria-hidden="true"> *</span> : null}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? 'true' : undefined}
        aria-describedby={[ayuda ? idAyuda : null, error ? idError : null].filter(Boolean).join(' ') || undefined}
        {...props}
      />
      {ayuda ? <span className="campo__ayuda" id={idAyuda}>{ayuda}</span> : null}
      {error ? <span className="campo__error" id={idError}>{error}</span> : null}
    </div>
  );
}

export function CampoCasilla({
  etiqueta,
  ayuda,
  ancho,
  ...props
}: { etiqueta: string; ayuda?: string; ancho?: boolean } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const idAyuda = `${id}-ayuda`;
  return (
    <div className={ancho ? 'campo campo--ancho' : 'campo'}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
        <input
          id={id}
          type="checkbox"
          style={{ width: 'auto', marginTop: '0.2rem' }}
          aria-describedby={ayuda ? idAyuda : undefined}
          {...props}
        />
        <label htmlFor={id} style={{ fontWeight: 500 }}>{etiqueta}</label>
      </div>
      {ayuda ? <span className="campo__ayuda" id={idAyuda}>{ayuda}</span> : null}
    </div>
  );
}
