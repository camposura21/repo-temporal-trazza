// __integration__/demoFlow.emu.js  (dueño: P1)
// El guion de la demo (docs/DEMO.md) de punta a punta contra el emulador, con los servicios
// de P1 y P2 y los cálculos del Centro de despacho de P2. Hito del día 4.
import { terminate } from 'firebase/firestore';
import { countByStage, kmOptimized } from '../src/features/dispatch/dispatchMath';
import { createRoute, listenDriverRoute, listenRoutes, startRoute } from '../src/features/routes/routesService';
import { getShipment, listenShipments } from '../src/features/shipments/shipmentsService';
import { changeStatus } from '../src/features/shipments/statusMachine';
import { db } from '../src/lib/firebase';
import { todayISO } from '../src/lib/dates';

const DELIVERY = { photoUri: 'file:///foto.jpg', signatureBase64: 'data:image/png;base64,AAAA', description: 'Recibió la clienta' };
const fail = (reason) => ({ reason, photoUri: 'file:///foto.jpg', description: 'Descripción de la visita fallida' });
// Último valor del listener cuando deja de cambiar: tras una transacción, el primer valor
// puede venir de la caché local y llegar viejo; el confirmado por el servidor llega enseguida.
const first = (subscribe, quietMs = 400) =>
  new Promise((resolve) => {
    let timer, last, cancel;
    cancel = subscribe((v) => {
      last = v;
      clearTimeout(timer);
      timer = setTimeout(() => {
        cancel?.();
        resolve(last);
      }, quietMs);
    });
  });

const date = todayISO();
const counters = async () => countByStage(await first((cb) => listenShipments({ date }, cb)));

beforeAll(() => require('./reseed')(), 60000);
afterAll(() => terminate(db));

test('guion de la demo de punta a punta', async () => {
  // 0:00 contadores de partida
  expect(await counters()).toEqual({ pendientes: 51, enRuta: 6, entregados: 2 });

  // 1:30 Generar ruta óptima en Z1: Kevin, con los 2 reintentos
  const { routeId } = await createRoute({ zoneId: 'Z1', date });
  const z1 = await first((cb) => listenDriverRoute({ driverId: 'D1', date }, cb));
  expect(z1).toMatchObject({ id: routeId, code: 'Ruta B', status: 'asignada' });
  expect(z1.stops.map((s) => s.shipmentId)).toEqual(expect.arrayContaining(['SIM-0401', 'SIM-0402']));
  expect(z1.stops).toHaveLength(12); // 10 pendientes + 2 reintentos
  expect(await counters()).toEqual({ pendientes: 39, enRuta: 18, entregados: 2 });

  // 3:00 Vista motorista de Jorge: Ruta A, 2 de 8, próxima SIM-0419
  const rutaA = await first((cb) => listenDriverRoute({ driverId: 'D2', date }, cb));
  expect(rutaA).toMatchObject({ code: 'Ruta A', status: 'en_curso', estEnd: `${date}T12:20:00-06:00` });

  // 5:30 Completar entrega de SIM-0419 → Entregados sube a 3
  expect((await changeStatus({ shipment: await getShipment('SIM-0419'), to: 'entregado', payload: DELIVERY, driverId: 'D2' })).status).toBe('entregado');
  expect((await counters()).entregados).toBe(3);

  // 6:30 SIM-0420 no entregado → reintento programado; vuelve a contar como pendiente
  expect((await changeStatus({ shipment: await getShipment('SIM-0420'), to: 'no_entregado', payload: fail('Cliente ausente'), driverId: 'D2' })).status).toBe('no_entregado');
  expect(await counters()).toEqual({ pendientes: 40, enRuta: 16, entregados: 3 });

  // 7:30 Kevin inicia su ruta
  expect(await startRoute(routeId, 'D1')).toEqual({ count: 12 });
  expect((await getShipment('SIM-0401')).status).toBe('en_ruta');

  // 8:00 SIM-0401 era su reintento: segundo fallo → vuelve a bodega
  expect((await changeStatus({ shipment: await getShipment('SIM-0401'), to: 'no_entregado', payload: fail('Dirección incorrecta'), driverId: 'D1' })).status).toBe('devuelto');
  expect(await getShipment('SIM-0401')).toMatchObject({ status: 'devuelto', attempts: 2 });

  // 9:00 KPI Km optimizados de las rutas del día
  const routes = await first((cb) => listenRoutes({ date }, cb));
  const kpi = kmOptimized(routes);
  expect(routes).toHaveLength(2);
  expect(kpi.km).toBeGreaterThan(0);
});
