import { useEffect, useRef, useState } from 'react';

/**
 * Numero que "sube" hasta su valor. Con "reducir movimiento" (o si el valor
 * no es numerico) muestra el resultado de inmediato.
 */
export function Contador({
  valor,
  formato,
  duracionMs = 900,
}: {
  valor: number;
  formato: (n: number) => string;
  duracionMs?: number;
}) {
  const [mostrado, setMostrado] = useState(valor);
  const anterior = useRef(0);

  useEffect(() => {
    let reducir = false;
    try {
      reducir = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reducir = false;
    }
    if (reducir || !Number.isFinite(valor)) {
      setMostrado(valor);
      anterior.current = valor;
      return;
    }

    const desde = anterior.current;
    const inicio = performance.now();
    let cuadro = 0;
    const paso = (ahora: number) => {
      const avance = Math.min(1, (ahora - inicio) / duracionMs);
      const suavizado = 1 - Math.pow(1 - avance, 3);
      setMostrado(desde + (valor - desde) * suavizado);
      if (avance < 1) cuadro = requestAnimationFrame(paso);
      else anterior.current = valor;
    };
    cuadro = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(cuadro);
  }, [valor, duracionMs]);

  return <>{formato(mostrado)}</>;
}
