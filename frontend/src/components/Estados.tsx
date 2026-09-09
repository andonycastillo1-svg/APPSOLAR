import { useEffect, useRef, type ReactNode } from 'react';
import { ErrorApi } from '../lib/api';

/**
 * Estados visuales obligatorios de cada pantalla:
 * carga, vacio, error, sin permisos y exito.
 */

export function Cargando({ mensaje = 'Cargando informacion...' }: { mensaje?: string }) {
  return (
    <div className="estado" role="status" aria-live="polite">
      <span className="cargando" aria-hidden="true" />
      <p style={{ marginTop: '0.8rem' }}>{mensaje}</p>
    </div>
  );
}

export function EsqueletoTabla({ filas = 5 }: { filas?: number }) {
  return (
    <div aria-hidden="true" style={{ padding: '0.6rem' }}>
      {Array.from({ length: filas }).map((_, indice) => (
        <div key={indice} className="esqueleto" style={{ width: `${95 - indice * 6}%` }} />
      ))}
    </div>
  );
}

export function Vacio({
  titulo = 'No hay informacion para mostrar',
  descripcion,
  accion,
}: {
  titulo?: string;
  descripcion?: string;
  accion?: ReactNode;
}) {
  return (
    <div className="estado">
      <p className="estado__titulo">{titulo}</p>
      {descripcion ? <p>{descripcion}</p> : null}
      {accion ? <div style={{ marginTop: '0.8rem' }}>{accion}</div> : null}
    </div>
  );
}

export function SinPermiso({ permiso }: { permiso?: string }) {
  return (
    <div className="mensaje mensaje--alerta" role="status">
      <div>
        <strong>No tiene permisos para ver esta seccion</strong>
        Su rol no incluye {permiso ? <code>{permiso}</code> : 'los permisos necesarios'}. Si
        considera que deberia tener acceso, solicitelo al administrador del sistema.
      </div>
    </div>
  );
}

export function MensajeError({
  error,
  alReintentar,
}: {
  error: unknown;
  alReintentar?: () => void;
}) {
  const esApi = error instanceof ErrorApi;
  const mensaje = esApi
    ? error.message
    : error instanceof Error
      ? error.message
      : 'Ocurrio un error inesperado.';

  if (esApi && error.estado === 403) {
    return <SinPermiso permiso={(error.detalles as { permiso?: string })?.permiso} />;
  }

  return (
    <div className="mensaje mensaje--error" role="alert">
      <div style={{ flex: 1 }}>
        <strong>No fue posible completar la operacion</strong>
        {mensaje}
        {esApi && Array.isArray(error.detalles) ? (
          <ul style={{ margin: '0.4rem 0 0 1rem' }}>
            {(error.detalles as Array<{ campo?: string; mensaje?: string }>).map((d, i) => (
              <li key={i}>
                {d.campo ? <strong style={{ display: 'inline' }}>{d.campo}: </strong> : null}
                {d.mensaje}
              </li>
            ))}
          </ul>
        ) : null}
        {esApi && error.correlationId ? (
          <p style={{ fontSize: '0.74rem', marginTop: '0.4rem', marginBottom: 0 }}>
            Referencia para soporte: <code>{error.correlationId}</code>
          </p>
        ) : null}
        {alReintentar ? (
          <button type="button" className="boton boton--secundario boton--pequeno" style={{ marginTop: '0.6rem' }} onClick={alReintentar}>
            Reintentar
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function MensajeExito({ children }: { children: ReactNode }) {
  return (
    <div className="mensaje mensaje--exito" role="status" aria-live="polite">
      <div>{children}</div>
    </div>
  );
}

export function MensajeAlerta({ titulo, children }: { titulo?: string; children: ReactNode }) {
  return (
    <div className="mensaje mensaje--alerta" role="status">
      <div>
        {titulo ? <strong>{titulo}</strong> : null}
        {children}
      </div>
    </div>
  );
}

export function MensajeInfo({ titulo, children }: { titulo?: string; children: ReactNode }) {
  return (
    <div className="mensaje mensaje--info">
      <div>
        {titulo ? <strong>{titulo}</strong> : null}
        {children}
      </div>
    </div>
  );
}

/** Anuncia mensajes a lectores de pantalla sin alterar el diseno. */
export function Anuncio({ mensaje }: { mensaje: string | null }) {
  return (
    <div className="solo-lectores" role="status" aria-live="polite" aria-atomic="true">
      {mensaje ?? ''}
    </div>
  );
}

/** Modal accesible: foco atrapado, cierre con Escape y etiqueta asociada. */
export function Modal({
  titulo,
  children,
  alCerrar,
  ancho,
}: {
  titulo: string;
  children: ReactNode;
  alCerrar: () => void;
  ancho?: boolean;
}) {
  const contenedor = useRef<HTMLDivElement>(null);

  // `alCerrar` normalmente es una funcion nueva en cada render del llamador
  // (p. ej. `alCerrar={() => setFormulario(null)}`). Si el efecto de abajo
  // dependiera de ella, cada tecla escrita en un campo del modal (que
  // actualiza estado y vuelve a renderizar) reiniciaria el efecto: le
  // devolveria el foco al elemento anterior y luego al primer campo del
  // modal, dejando escribir una sola letra a la vez. La referencia evita
  // ese reinicio sin depender de que el llamador memorice la funcion.
  const alCerrarRef = useRef(alCerrar);
  useEffect(() => {
    alCerrarRef.current = alCerrar;
  }, [alCerrar]);

  useEffect(() => {
    const anterior = document.activeElement as HTMLElement | null;
    const primero = contenedor.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    );
    primero?.focus();

    const alPresionar = (evento: KeyboardEvent) => {
      if (evento.key === 'Escape') {
        evento.stopPropagation();
        alCerrarRef.current();
        return;
      }
      if (evento.key !== 'Tab' || !contenedor.current) return;

      const focalizables = Array.from(
        contenedor.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focalizables.length === 0) return;

      const inicio = focalizables[0];
      const fin = focalizables[focalizables.length - 1];

      if (evento.shiftKey && document.activeElement === inicio) {
        evento.preventDefault();
        fin.focus();
      } else if (!evento.shiftKey && document.activeElement === fin) {
        evento.preventDefault();
        inicio.focus();
      }
    };

    document.addEventListener('keydown', alPresionar, true);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', alPresionar, true);
      document.body.style.overflow = '';
      anterior?.focus();
    };
    // Se ejecuta solo al abrir y al cerrar el modal (ver alCerrarRef arriba).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="modal-fondo"
      onMouseDown={(evento) => {
        if (evento.target === evento.currentTarget) alCerrar();
      }}
    >
      <div
        className={ancho ? 'modal modal--ancho' : 'modal'}
        role="dialog"
        aria-modal="true"
        aria-labelledby="titulo-modal"
        ref={contenedor}
      >
        <div className="tarjeta__titulo">
          <h2 id="titulo-modal">{titulo}</h2>
          <button type="button" className="boton boton--secundario boton--pequeno" onClick={alCerrar}>
            Cerrar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Confirmacion obligatoria para operaciones destructivas o sensibles. */
export function Confirmacion({
  titulo,
  descripcion,
  textoConfirmar = 'Confirmar',
  peligroso,
  alConfirmar,
  alCancelar,
  ocupado,
  children,
}: {
  titulo: string;
  descripcion: ReactNode;
  textoConfirmar?: string;
  peligroso?: boolean;
  alConfirmar: () => void;
  alCancelar: () => void;
  ocupado?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal titulo={titulo} alCerrar={alCancelar}>
      <div>{descripcion}</div>
      {children}
      <div className="acciones" style={{ marginTop: '1.1rem', justifyContent: 'flex-end' }}>
        <button type="button" className="boton boton--secundario" onClick={alCancelar} disabled={ocupado}>
          Cancelar
        </button>
        <button
          type="button"
          className={peligroso ? 'boton boton--peligro' : 'boton'}
          onClick={alConfirmar}
          disabled={ocupado}
        >
          {ocupado ? 'Procesando...' : textoConfirmar}
        </button>
      </div>
    </Modal>
  );
}
