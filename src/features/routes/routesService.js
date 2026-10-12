// src/features/routes/routesService.js  (dueño: P2)
// Rutas del día: lecturas (listen*), createRoute (Generar ruta óptima) y startRoute (Iniciar ruta).
// Única puerta para crear o iniciar rutas. No escribe directo: la ruta se guarda junto con
// la asignación de sus envíos en statusMachine (P1, C4 y C5). Los listen* devuelven la función para cancelar.
import { collection, doc, onSnapshot, query, where } from 'firebase/firestore';
import { ROUTE_STATUS, STATUS } from '../../constants';
import { USE_MOCKS, db } from '../../lib/firebase';
import { mockDb } from '../../mocks';
import { optimizeRoute } from '../../optimizer';
import { getDepot, listenZones } from '../catalog/catalogService';
import { isRoutable } from '../dispatch/dispatchMath';
import { assignToRoute, changeStatusMany } from '../shipments/statusMachine';
import { listenShipments } from '../shipments/shipmentsService';

const CLOSED = [STATUS.ENTREGADO, STATUS.NO_ENTREGADO, STATUS.DEVUELTO];
export const READ_ERROR = 'No se pudo leer la ruta. Revise la conexión e intente de nuevo.';
export const READ_TIMEOUT_MS = 15000;

// C18: como los listen* de P1, onError (opcional) recibe un Error con mensaje listo para mostrar
const readError = (where_, onError) => (err) => {
  console.error(`[routes] ${where_}:`, err);
  onError?.(new Error(READ_ERROR));
};

/**
 * Primer valor de un listen* y cancela; así se lee una vez con las mismas funciones del contrato.
 * Rechaza con el error del listen* (C18) o, si no llega nada en 15 s, con READ_ERROR:
 * "Generar ruta óptima" nunca se queda en "Calculando…".
 */
function once(subscribe) {
  return new Promise((resolve, reject) => {
    let cancel = null,
      done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      fn(value);
      cancel?.();
    };
    const timer = setTimeout(() => finish(reject, new Error(READ_ERROR)), READ_TIMEOUT_MS);
    cancel = subscribe(
      (value) => finish(resolve, value),
      (err) => finish(reject, err instanceof Error ? err : new Error(READ_ERROR)),
    );
    if (done) cancel?.(); // por si el primer valor llegó antes de tener la función para cancelar
  });
}

/**
 * Hora de salida para ETA y estEnd (N12): ahora, si está entre 07:00 y 18:00 del día de
 * la ruta; si no (de noche, o una ruta de otro día), las 08:00 de ese día.
 * @param {string} date  "2026-10-12"
 * @param {Date} [now]
 * @returns {Date}
 */
export function routeStartAt(date, now = new Date()) {
  const [y, m, d] = date.split('-').map(Number);
  const at = (h) => new Date(y, m - 1, d, h, 0, 0, 0);
  return now >= at(7) && now <= at(18) ? now : at(8);
}

/** "Ruta A", "Ruta B"… en orden de creación del día (después de la Z: "Ruta 27"). */
export const routeCode = (index) => `Ruta ${index < 26 ? String.fromCharCode(65 + index) : index + 1}`;

/** R-{date}-{zoneId}; si ya existe, -2, -3… */
export function nextRouteId({ date, zoneId }, existingIds) {
  const base = `R-${date}-${zoneId}`;
  if (!existingIds.has(base)) return base;
  let n = 2;
  while (existingIds.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Una ruta está abierta si alguna de sus paradas sigue en ella sin cerrar.
 * Un envío que ya pasó a otra ruta (reintento) no la mantiene abierta.
 */
export function isRouteOpen(route, shipmentsById) {
  return route.stops.some((st) => {
    const s = shipmentsById[st.shipmentId];
    return s && s.routeId === route.id && !CLOSED.includes(s.status);
  });
}

/**
 * Una ruta por id (ej. "R-2026-10-12-Z2").
 * @param {string} routeId
 * @param {(route: object|null) => void} cb  null si no existe
 * @param {(err: Error) => void} [onError]  mensaje listo para mostrar (C18)
 * @returns {() => void} cancelar
 */
export function listenRoute(routeId, cb, onError) {
  if (USE_MOCKS) return mockDb.listen('routes', (docs) => docs.find((r) => r.id === routeId) ?? null, cb);
  return onSnapshot(
    doc(db, 'routes', routeId),
    (snap) => cb(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    readError('listenRoute', onError),
  );
}

/**
 * Todas las rutas de una fecha (Centro de despacho: nombre de ruta en cada tarjeta).
 * @param {{ date: string }} filters
 * @param {(routes: object[]) => void} cb  ordenadas por zona
 * @param {(err: Error) => void} [onError]  mensaje listo para mostrar (C18)
 * @returns {() => void} cancelar
 */
export function listenRoutes({ date }, cb, onError) {
  const byZone = (a, b) => a.zoneId.localeCompare(b.zoneId) || a.id.localeCompare(b.id);
  if (USE_MOCKS) return mockDb.listen('routes', (docs) => docs.filter((r) => r.date === date).sort(byZone), cb);
  return onSnapshot(
    query(collection(db, 'routes'), where('date', '==', date)),
    (snap) => cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort(byZone)),
    readError('listenRoutes', onError),
  );
}

/**
 * La ruta de un motorista en una fecha (un motorista por zona → una ruta abierta por día).
 * Si tiene varias (la anterior ya cerrada), entrega la más reciente.
 * @param {{ driverId: string, date: string }} filters
 * @param {(route: object|null) => void} cb  null si el motorista no tiene ruta en esa fecha
 * @param {(err: Error) => void} [onError]  mensaje listo para mostrar (C18)
 * @returns {() => void} cancelar
 */
export function listenDriverRoute({ driverId, date }, cb, onError) {
  // createdAt es ISO en mocks y Timestamp en Firestore
  const ms = (v) => (typeof v?.toMillis === 'function' ? v.toMillis() : Date.parse(v) || 0);
  const latest = (list) => list.sort((a, b) => ms(b.createdAt) - ms(a.createdAt))[0] ?? null;
  const match = (r) => r.driverId === driverId && r.date === date;
  if (USE_MOCKS) return mockDb.listen('routes', (docs) => latest(docs.filter(match)), cb);
  return onSnapshot(
    query(collection(db, 'routes'), where('driverId', '==', driverId), where('date', '==', date)),
    (snap) => cb(latest(snap.docs.map((d) => ({ id: d.id, ...d.data() })))),
    readError('listenDriverRoute', onError),
  );
}

/**
 * Generar ruta óptima de una zona: ordena sus pendientes y reintentos, guarda routes/{id}
 * y pasa los envíos a asignado con assignToRoute (P1).
 * Si hay más de maxStops, entran las primeras por prioridad y hora; el resto sigue pendiente.
 * @param {{ zoneId: string, date: string }} args
 * @returns {Promise<{ routeId: string, skipped: object[] }>} skipped: envíos que no entraron (C20)
 */
export async function createRoute({ zoneId, date }) {
  const [zones, zoneShipments, routes, depot] = await Promise.all([
    once((cb, onErr) => listenZones(cb, onErr)),
    once((cb, onErr) => listenShipments({ date, zoneId }, cb, onErr)),
    once((cb, onErr) => listenRoutes({ date }, cb, onErr)),
    getDepot().catch(() => null), // sin depósito se avisa abajo con su propio mensaje
  ]);

  const zone = zones.find((z) => z.id === zoneId);
  if (!zone) throw new Error(`No existe la zona ${zoneId}`);
  if (!zone.driverId) throw new Error(`La zona ${zone.name} no tiene motorista`);
  if (!depot) throw new Error('Falta el depósito de salida');

  const shipmentsById = Object.fromEntries(zoneShipments.map((s) => [s.id, s]));
  if (routes.some((r) => r.zoneId === zoneId && isRouteOpen(r, shipmentsById)))
    throw new Error('La zona ya tiene una ruta abierta hoy');

  const candidates = zoneShipments.filter(isRoutable);
  if (!candidates.length) throw new Error('No hay envíos pendientes en esta zona');

  const plan = optimizeRoute({ depot, stops: candidates, options: { startAt: routeStartAt(date) } });
  const routeId = nextRouteId({ date, zoneId }, new Set(routes.map((r) => r.id)));
  const route = {
    code: routeCode(routes.length),
    date,
    zoneId,
    driverId: zone.driverId,
    status: ROUTE_STATUS.ASIGNADA,
    stops: plan.legs,
    totalKm: plan.totalKm,
    baselineKm: plan.baselineKm,
    estEnd: plan.estEnd,
  };

  // Ruta y asignación en una sola escritura: si algo falla no se guarda nada.
  // El error de statusMachine sale tal cual (mensaje listo para mostrar).
  await assignToRoute({ routeId, stops: plan.legs, driverId: zone.driverId, route });
  return { routeId, skipped: plan.skipped };
}

/**
 * Iniciar ruta (Vista motorista): todas sus paradas pasan a en_ruta y la ruta a en_curso.
 * @param {string} routeId
 * @param {string} driverId
 * @returns {Promise<{ count: number }>} paradas que salieron
 */
export async function startRoute(routeId, driverId) {
  const route = await once((cb, onErr) => listenRoute(routeId, cb, onErr));
  if (!route) throw new Error(`No existe la ruta ${routeId}`);
  if (route.status === ROUTE_STATUS.EN_CURSO) throw new Error(`La ${route.code} ya está en curso`);

  // Paradas a en_ruta y ruta a en_curso en la misma escritura
  return changeStatusMany({
    shipmentIds: route.stops.map((st) => st.shipmentId),
    to: STATUS.EN_RUTA,
    driverId,
    routeStatus: { routeId, status: ROUTE_STATUS.EN_CURSO },
  });
}
