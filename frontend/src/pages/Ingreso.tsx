import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useSesion } from '../lib/auth';
import { ErrorApi } from '../lib/api';
import { CampoTexto } from '../components/Campos';
import { Cargando } from '../components/Estados';

export function PaginaIngreso() {
  const { usuario, cargando, iniciarSesion } = useSesion();
  const navegar = useNavigate();
  const ubicacion = useLocation();
  const destino = (ubicacion.state as { desde?: string } | null)?.desde ?? '/';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detalle, setDetalle] = useState<string[]>([]);
  const [enviando, setEnviando] = useState(false);

  if (cargando) return <Cargando mensaje="Verificando su sesion..." />;
  if (usuario) return <Navigate to={destino} replace />;

  const enviar = async (evento: FormEvent) => {
    evento.preventDefault();
    setError(null);
    setDetalle([]);

    if (!email.trim() || !password) {
      setError('Ingrese su correo electronico y su contraseña.');
      return;
    }

    setEnviando(true);
    try {
      await iniciarSesion(email.trim().toLowerCase(), password);
      navegar(destino, { replace: true });
    } catch (fallo) {
      if (fallo instanceof ErrorApi) {
        setError(fallo.message);
        if (Array.isArray(fallo.detalles)) {
          setDetalle(
            (fallo.detalles as Array<{ mensaje?: string }>)
              .map((d) => d.mensaje ?? '')
              .filter(Boolean),
          );
        }
      } else {
        setError('No fue posible conectar con el servidor. Verifique su conexion e intente de nuevo.');
      }
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="login">
      <main className="login__caja">
        <div className="login__marca">
          <img className="login__logo" src="/logo-sbc.png" alt="SBC - Servicios Básicos Centralizados" />
          <h1>Sistema Centralizado de Monitoreo Energetico</h1>
          <p>Analisis de produccion solar · Retse, S.A.</p>
        </div>

        <form onSubmit={enviar} noValidate>
          {error ? (
            <div className="mensaje mensaje--error" role="alert">
              <div>
                <strong>No fue posible iniciar sesion</strong>
                {error}
                {detalle.length > 0 ? (
                  <ul style={{ margin: '0.4rem 0 0 1rem' }}>
                    {detalle.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="formulario formulario--una">
            <CampoTexto
              etiqueta="Correo electronico"
              type="email"
              name="email"
              autoComplete="username"
              obligatorio
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="usuario@retse.com.gt"
            />
            <CampoTexto
              etiqueta="Contraseña"
              type="password"
              name="password"
              autoComplete="current-password"
              obligatorio
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          <button type="submit" className="boton" style={{ width: '100%', marginTop: '1rem' }} disabled={enviando}>
            {enviando ? 'Verificando...' : 'Iniciar sesion'}
          </button>

          <p style={{ fontSize: '0.76rem', color: 'var(--texto-suave)', marginTop: '1rem', marginBottom: 0 }}>
            Tras varios intentos fallidos su usuario se bloquea temporalmente. Si olvido su contraseña,
            solicite el restablecimiento al administrador del sistema.
          </p>
        </form>
      </main>
    </div>
  );
}
