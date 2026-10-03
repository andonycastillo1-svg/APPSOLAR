import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ErrorApi } from '../lib/api';
import { NOMBRE_ROL, useSesion } from '../lib/auth';
import { CampoTexto } from '../components/Campos';
import { MensajeAlerta, MensajeError, MensajeExito, MensajeInfo } from '../components/Estados';
import { fechaHora } from '../lib/formato';

export function PaginaPerfil() {
  const { usuario, debeCambiarPassword, ultimoAcceso, refrescarPerfil } = useSesion();
  const [actual, setActual] = useState('');
  const [nueva, setNueva] = useState('');
  const [confirmacion, setConfirmacion] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [exito, setExito] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const sesiones = useQuery({
    queryKey: ['sesiones-activas'],
    queryFn: async () => (await api.obtener<{ sesionesActivas: number }>('/auth/sesiones')).datos,
  });

  const enviar = async (evento: FormEvent) => {
    evento.preventDefault();
    setError(null);
    setExito(null);

    if (nueva !== confirmacion) {
      setError(new Error('La nueva contraseña y su confirmacion no coinciden.'));
      return;
    }

    setEnviando(true);
    try {
      const respuesta = await api.crear<{ mensaje: string }>('/auth/change-password', {
        passwordActual: actual,
        passwordNueva: nueva,
      });
      setExito(respuesta.datos.mensaje);
      setActual('');
      setNueva('');
      setConfirmacion('');
      await refrescarPerfil();
      void sesiones.refetch();
    } catch (fallo) {
      setError(fallo);
    } finally {
      setEnviando(false);
    }
  };

  const errores = error instanceof ErrorApi ? error.erroresPorCampo : {};

  return (
    <>
      <h1>Mi perfil</h1>

      <section className="tarjeta">
        <h2>Datos de la cuenta</h2>
        <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.45rem 1.2rem', fontSize: '0.9rem' }}>
          <dt style={{ fontWeight: 640 }}>Nombre</dt>
          <dd style={{ margin: 0 }}>{usuario?.nombre}</dd>
          <dt style={{ fontWeight: 640 }}>Correo</dt>
          <dd style={{ margin: 0 }}>{usuario?.email}</dd>
          <dt style={{ fontWeight: 640 }}>Rol</dt>
          <dd style={{ margin: 0 }}>{usuario ? NOMBRE_ROL[usuario.rol] : ''}</dd>
          <dt style={{ fontWeight: 640 }}>Ultimo acceso</dt>
          <dd style={{ margin: 0 }}>{fechaHora(ultimoAcceso)}</dd>
          <dt style={{ fontWeight: 640 }}>Sesiones activas</dt>
          <dd style={{ margin: 0 }}>{sesiones.data?.sesionesActivas ?? '—'}</dd>
        </dl>
      </section>

      <section className="tarjeta">
        <h2>Permisos efectivos</h2>
        <p style={{ fontSize: '0.85rem', color: 'var(--texto-suave)' }}>
          Estos son los permisos que el servidor valida en cada operacion. Incluyen los de su rol mas los
          otorgados o revocados individualmente por un administrador.
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
          {usuario?.permisos.map((permiso) => (
            <span key={permiso} className="etiqueta etiqueta--azul">
              {permiso}
            </span>
          ))}
        </div>
      </section>

      <section className="tarjeta">
        <h2>Cambiar contraseña</h2>

        {debeCambiarPassword ? (
          <MensajeAlerta titulo="Cambio de contraseña requerido">
            Su contraseña fue asignada por un administrador. Debe reemplazarla por una propia antes de
            continuar utilizando el sistema.
          </MensajeAlerta>
        ) : null}

        {exito ? <MensajeExito>{exito}</MensajeExito> : null}
        {error ? <MensajeError error={error} /> : null}

        <MensajeInfo titulo="Politica de contraseñas">
          Minimo 10 caracteres, con al menos una mayuscula, una minuscula, un numero y un caracter
          especial. Al cambiarla se cerraran sus demas sesiones activas.
        </MensajeInfo>

        <form onSubmit={enviar} noValidate>
          <div className="formulario">
            <CampoTexto
              etiqueta="Contraseña actual"
              type="password"
              autoComplete="current-password"
              obligatorio
              value={actual}
              error={errores.passwordActual}
              onChange={(e) => setActual(e.target.value)}
            />
            <CampoTexto
              etiqueta="Nueva contraseña"
              type="password"
              autoComplete="new-password"
              obligatorio
              value={nueva}
              error={errores.passwordNueva}
              onChange={(e) => setNueva(e.target.value)}
            />
            <CampoTexto
              etiqueta="Confirmar nueva contraseña"
              type="password"
              autoComplete="new-password"
              obligatorio
              value={confirmacion}
              onChange={(e) => setConfirmacion(e.target.value)}
            />
          </div>
          <div className="acciones" style={{ marginTop: '1rem' }}>
            <button type="submit" className="boton" disabled={enviando}>
              {enviando ? 'Guardando...' : 'Actualizar contraseña'}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
