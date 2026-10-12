// app/despacho/index.js  (dueño: P2) — Centro de despacho
// Lee todo por los servicios del contrato; no escribe en Firestore: "Generar ruta óptima"
// llama createRoute, que guarda la ruta y asigna los envíos por statusMachine (P1).
// Dirección visual (DIRECCION-VISUAL.md §3 y N30): fondo gris claro, tarjetas blancas,
// métricas con IconTile, colores por estado; sin adornos (ni etiquetas en mayúsculas ni conteos).
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { Button } from '../../src/components/Button';
import { Card } from '../../src/components/Card';
import { Icon } from '../../src/components/Icon';
import { IconTile } from '../../src/components/IconTile';
import { RouteMap } from '../../src/components/RouteMap';
import { Skeleton } from '../../src/components/Skeleton';
import { PRIORITY } from '../../src/constants';
import { getDepot, listenDrivers, listenZones } from '../../src/features/catalog/catalogService';
import { Counters } from '../../src/features/dispatch/Counters';
import { EmptyNote } from '../../src/features/dispatch/EmptyNote';
import {
  assignmentLabel,
  countByStage,
  dateShiftLabel,
  isRoutable,
  kmOptimized,
  latestZoneRoute,
  matchesPriority,
  splitByZone,
  toMapStops,
} from '../../src/features/dispatch/dispatchMath';
import { PriorityFilter, ZoneFilter } from '../../src/features/dispatch/PriorityFilter';
import { RouteToast } from '../../src/features/dispatch/RouteToast';
import { ShipmentCard } from '../../src/features/dispatch/ShipmentCard';
import { createRoute, isRouteOpen, listenRoutes } from '../../src/features/routes/routesService';
import { listenShipments } from '../../src/features/shipments/shipmentsService';
import { useAppStore } from '../../src/store/useAppStore';
import { colors, elevation, fonts, radius, spacing, tones, typography } from '../../src/theme';

const indexBy = (list) => Object.fromEntries(list.map((x) => [x.id, x]));

function ErrorBox({ message }) {
  if (!message) return null;
  return (
    <View style={styles.errorBox} accessibilityLiveRegion="polite">
      <Icon name="error_outline" size={20} color={colors.onErrorContainer} />
      <Text style={styles.errorText}>{message}</Text>
    </View>
  );
}

// KPI "Km optimizados" en una sola fila (N30): ícono, etiqueta, número y píldora a la derecha
function KmRow({ km, pct }) {
  const t = tones.warning;
  return (
    <View style={styles.kmRow} accessible accessibilityLabel={`Km optimizados: ${km.toFixed(1)}`}>
      <IconTile icon="route" tone="warning" size={36} />
      <Text style={styles.kmLabel} numberOfLines={1}>
        Km optimizados
      </Text>
      <Text style={styles.kmValue}>{km.toFixed(1)}</Text>
      {pct >= 0.5 ? (
        <View style={[styles.kmPill, { backgroundColor: t.bg }]}>
          <Text style={[styles.kmPillText, { color: t.fg }]} numberOfLines={1}>
            −{Math.round(pct)}%
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export default function CentroDespacho() {
  const router = useRouter();
  const date = useAppStore((s) => s.date);
  const setCurrentDriverId = useAppStore((s) => s.setCurrentDriverId);

  const [zones, setZones] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [depot, setDepot] = useState(null);
  const [depotMissing, setDepotMissing] = useState(false);
  const [routes, setRoutes] = useState([]);
  const [readError, setReadError] = useState(null); // C18: mensaje listo para mostrar
  const [zoneId, setZoneId] = useState(null);
  const [priority, setPriority] = useState('todos');
  const [selectedId, setSelectedId] = useState(null);

  // Los envíos se guardan con la consulta que los produjo: si cambia la zona o la
  // fecha, la lista anterior deja de valer y la pantalla muestra "cargando".
  const queryKey = `${date}|${zoneId ?? ''}`;
  const [loaded, setLoaded] = useState({ key: null, list: [] });
  const shipments = loaded.key === queryKey ? loaded.list : null; // null = cargando

  // Generar ruta óptima: en curso, último resultado (por zona) y error para mostrar tal cual
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null); // { zoneId, routeId, skipped } | { zoneId, error }

  const onReadError = useCallback((err) => setReadError(err.message), []);
  useEffect(() => listenZones(setZones, onReadError), [onReadError]);
  useEffect(() => listenDrivers(setDrivers, onReadError), [onReadError]);
  useEffect(() => {
    getDepot()
      .then((d) => (d ? setDepot(d) : setDepotMissing(true)))
      .catch(() => setDepotMissing(true));
  }, []);
  useEffect(() => listenRoutes({ date }, setRoutes, onReadError), [date, onReadError]);
  useEffect(
    () =>
      listenShipments(
        { date, zoneId: zoneId ?? undefined },
        (list) => {
          setReadError(null);
          setLoaded({ key: queryKey, list });
        },
        onReadError,
      ),
    [date, zoneId, queryKey, onReadError],
  );

  const routesById = useMemo(() => indexBy(routes), [routes]);
  const driversById = useMemo(() => indexBy(drivers), [drivers]);
  const zone = zones.find((z) => z.id === zoneId) ?? null;
  const zoneRoute = zoneId ? latestZoneRoute(routes, zoneId) : null;

  const all = shipments ?? [];
  const counts = countByStage(all);
  const visible = all.filter(matchesPriority(priority));
  const { zoned, noZone } = splitByZone(visible);
  const routable = all.filter(isRoutable);
  const routeOpen = Boolean(zoneRoute && shipments && isRouteOpen(zoneRoute, indexBy(all)));
  const result = outcome?.zoneId === zoneId ? outcome : null;

  // Qué se dibuja en el mapa: la ruta de la zona con su línea, o los envíos visibles
  let mapStops, showPath;
  // (una ruta ya cerrada deja de dibujarse en cuanto hay pendientes para la siguiente)
  const showRoute = Boolean(zoneRoute && (routeOpen || !routable.length));
  if (showRoute) {
    const onRoute = all.filter((s) => s.routeId === zoneRoute.id).sort((a, b) => a.stopSequence - b.stopSequence);
    mapStops = toMapStops(onRoute, { numbered: true });
    showPath = true;
  } else {
    mapStops = toMapStops(zoned);
    showPath = false;
  }

  const selected = all.find((s) => s.id === selectedId) ?? null;
  const assignment = (s) => assignmentLabel(s, routesById, driversById);
  const openRoute = (routeId) => router.push(`/despacho/ruta/${routeId}`);
  // Props de cada tarjeta: con ruta, el chip "Ruta X - Nombre" lleva al seguimiento
  const cardProps = (s) => ({
    shipment: s,
    assignment: assignment(s),
    routeCode: routesById[s.routeId]?.code,
    onOpenRoute: routesById[s.routeId] ? () => openRoute(s.routeId) : undefined,
  });
  const kpi = kmOptimized(routes);

  // Píldoras de contexto de los contadores (V7, desde 400 px)
  const expressWaiting = routable.filter((s) => s.priority === PRIORITY.EXPRESS).length;
  const pills = {
    pendientes: `${expressWaiting} express`,
    enRuta: `${routes.length} ${routes.length === 1 ? 'ruta' : 'rutas'}`,
    entregados: all.length ? `${Math.round((counts.entregados / all.length) * 100)}% del día` : undefined,
  };

  async function generate() {
    const forZone = zoneId;
    setBusy(true);
    setSelectedId(null);
    try {
      const { routeId, skipped } = await createRoute({ zoneId: forZone, date });
      setOutcome({ zoneId: forZone, routeId, skipped });
    } catch (err) {
      setOutcome({ zoneId: forZone, error: err.message });
    } finally {
      setBusy(false);
    }
  }

  function goToDriver() {
    if (zone?.driverId) setCurrentDriverId(zone.driverId);
    router.replace('/motorista');
  }

  const canGenerate = Boolean(zoneId && depot && routable.length && !routeOpen && !busy);
  let generateHint = null;
  if (depotMissing) generateHint = 'Falta el depósito de salida';
  else if (!zoneId) generateHint = 'Elija una zona para generar su ruta.';
  else if (routeOpen) generateHint = `${zone?.name} ya tiene la ${zoneRoute.code} abierta hoy.`;
  else if (!routable.length) generateHint = 'No hay envíos pendientes en esta zona.';

  // Aviso de maxStops con lo que devuelve createRoute (C20)
  const skipped = result?.skipped?.length ?? 0;
  const createdRoute = result?.routeId ? routesById[result.routeId] : null;
  const routeDriver = zoneRoute ? driversById[zoneRoute.driverId] : null;

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <Text style={styles.title}>Centro de despacho</Text>
        <Text style={styles.subtitle}>
          {dateShiftLabel(date)} · {zone?.name ?? 'Todas las zonas'}
        </Text>
      </View>

      <ErrorBox message={readError} />

      <View style={styles.panel}>
        <KmRow km={kpi.km} pct={kpi.pct} />
      </View>

      <View style={styles.zones}>
        <ZoneFilter zones={zones} value={zoneId} onChange={setZoneId} />
      </View>

      <View style={styles.panel}>
        <View style={styles.scope}>
          <Icon name={zone ? 'place' : 'public'} size={16} color={colors.onSurfaceVariant} />
          <Text style={styles.scopeText} numberOfLines={1}>
            {zone ? `Hoy en ${zone.name}` : 'Hoy en todas las zonas'}
          </Text>
        </View>
        <Counters pendientes={counts.pendientes} enRuta={counts.enRuta} entregados={counts.entregados} pills={pills} />
        <View style={styles.filters}>
          <PriorityFilter value={priority} onChange={setPriority} />
        </View>
      </View>

      {shipments === null ? (
        <View style={styles.list} accessibilityLabel="Cargando envíos">
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.skeletonCard}>
              <Skeleton width="45%" height={12} />
              <Skeleton width="65%" height={20} style={styles.skeletonGap} />
              <Skeleton width="90%" height={14} style={styles.skeletonGap} />
              <Skeleton width={140} height={28} style={styles.skeletonGap} />
            </View>
          ))}
        </View>
      ) : (
        <View style={styles.list}>
          {noZone.length ? (
            <View style={styles.noZone}>
              <View style={styles.noZoneHead}>
                <Icon name="wrong_location" size={20} color={colors.onErrorContainer} />
                <Text style={styles.noZoneTitle}>Sin zona ({noZone.length})</Text>
              </View>
              <Text style={styles.noZoneBody}>
                Su ubicación no cae en ninguna zona ni municipio conocido. No entran a ninguna ruta hasta corregirlos.
              </Text>
              {noZone.map((s) => (
                <ShipmentCard
                  key={s.id}
                  {...cardProps(s)}
                  selected={s.id === selectedId}
                  onPress={() => setSelectedId(s.id)}
                />
              ))}
            </View>
          ) : null}
          {zoned.map((s) => (
            <ShipmentCard
              key={s.id}
              {...cardProps(s)}
              selected={s.id === selectedId}
              onPress={() => setSelectedId(s.id)}
            />
          ))}
          {!all.length ? (
            <EmptyNote
              icon="inbox"
              title={zone ? 'No hay envíos en esta zona' : 'No hay envíos hoy'}
              body={
                zone
                  ? `${zone.name} no tiene envíos programados para hoy.`
                  : 'Cuando lleguen pedidos para hoy aparecerán aquí.'
              }
            />
          ) : !visible.length ? (
            <EmptyNote
              icon="filter_alt_off"
              title={`No hay envíos ${priority === 'express' ? 'express' : 'normales'}`}
              body="Toque Todos para ver el resto."
            />
          ) : null}
        </View>
      )}

      <Card variant="elevated" padded={false} style={styles.panel}>
        <View style={styles.mapHead}>
          <Text style={styles.mapTitle}>Mapa de rutas</Text>
          <Text style={styles.subtitle}>
            {zone?.name ?? 'Zona metropolitana'} · {mapStops.length} {mapStops.length === 1 ? 'parada' : 'paradas'}
          </Text>
          {/* La ruta en su propio renglón: a 360 px no se parte entre "Ruta B -" y el nombre */}
          {showRoute ? (
            <View style={styles.routeLine}>
              <Icon name="two_wheeler" size={16} color={colors.onSurfaceVariant} />
              <Text style={styles.routeLineText} numberOfLines={1}>
                {zoneRoute.code}
                {routeDriver ? ` - ${routeDriver.name}` : ''}
              </Text>
            </View>
          ) : null}
          {/* Acciones arriba, en el encabezado del mapa, como el prototipo */}
          <View style={styles.actions}>
            <Button
              title="Vista motorista"
              icon="smartphone"
              variant="outlined"
              size="md"
              onPress={goToDriver}
              style={styles.grow}
            />
            <Button
              title={busy ? 'Calculando…' : 'Generar ruta óptima'}
              icon={busy ? 'hourglass_empty' : 'route'}
              size="md"
              disabled={!canGenerate}
              onPress={generate}
              style={styles.grow}
            />
          </View>
          {generateHint ? <Text style={styles.hint}>{generateHint}</Text> : null}
        </View>

        {zone && !showRoute && !busy && routable.length ? (
          <EmptyNote
            icon="alt_route"
            title="Sin ruta todavía"
            body={`${routable.length} ${routable.length === 1 ? 'envío espera' : 'envíos esperan'} en ${zone.name}. Toque Generar ruta óptima.`}
            style={styles.mapNote}
          />
        ) : null}

        <View style={styles.mapBox}>
          {/* El aviso va arriba del mapa: se ve apenas termina "Generar ruta óptima" */}
          {busy || showRoute ? (
            <View>
              {busy ? (
                <RouteToast loading />
              ) : (
                <RouteToast route={zoneRoute} driverName={routeDriver?.name} onPress={() => openRoute(zoneRoute.id)} />
              )}
            </View>
          ) : null}
          {skipped > 0 ? (
            <View style={styles.warningBox}>
              <Icon name="warning_amber" size={20} color={colors.onWarningContainer} />
              <Text style={styles.warningText}>
                {skipped} {skipped === 1 ? 'envío no cabe' : 'envíos no caben'} en la ruta (máximo{' '}
                {createdRoute?.stops.length ?? 25} paradas) y {skipped === 1 ? 'queda pendiente' : 'quedan pendientes'}.
              </Text>
            </View>
          ) : null}
          <ErrorBox message={result?.error} />
          <RouteMap
            depot={depot}
            stops={mapStops}
            showPath={showPath}
            selectedId={selectedId}
            onStopPress={setSelectedId}
            height={320}
          />
        </View>

        {selected ? (
          <View style={styles.selected}>
            <ShipmentCard {...cardProps(selected)} selected />
          </View>
        ) : null}
      </Card>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingTop: spacing.sm, paddingBottom: spacing.xxxl, gap: spacing.md },
  header: { paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, gap: spacing.xxs },
  title: { ...typography.headline, fontFamily: fonts.medium, color: colors.onSurface },
  subtitle: { ...typography.body, color: colors.onSurfaceVariant },
  zones: { marginHorizontal: -spacing.xs },
  kmRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 60,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.white,
    ...elevation[1],
  },
  kmLabel: { ...typography.body, color: colors.onSurfaceVariant, flex: 1 },
  kmValue: { ...typography.title, fontFamily: fonts.bold, color: colors.onSurface, fontVariant: ['tabular-nums'] },
  kmPill: { borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  kmPillText: typography.captionStrong,
  panel: { marginHorizontal: spacing.md },
  filters: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  skeletonCard: {
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.cardBorder,
    backgroundColor: colors.white,
  },
  skeletonGap: { marginTop: spacing.sm },
  scope: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.sm },
  scopeText: { ...typography.captionStrong, color: colors.onSurfaceVariant, flexShrink: 1 },
  list: { paddingHorizontal: spacing.md, gap: spacing.sm },
  noZone: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.errorContainer,
  },
  noZoneHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  noZoneTitle: { ...typography.titleSmall, color: colors.onErrorContainer },
  noZoneBody: { ...typography.caption, color: colors.onErrorContainer },
  mapHead: { paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.lg },
  routeLine: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: spacing.xxs },
  routeLineText: { ...typography.bodyStrong, color: colors.onSurfaceVariant, flexShrink: 1 },
  mapTitle: { ...typography.title, fontFamily: fonts.medium, color: colors.onSurface },
  mapBox: { marginHorizontal: spacing.md, marginBottom: spacing.md, gap: spacing.md },
  mapNote: { marginHorizontal: spacing.md, marginBottom: spacing.md },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    marginHorizontal: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.errorContainer,
  },
  errorText: { ...typography.body, color: colors.onErrorContainer, flex: 1 },
  warningBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.warningContainer,
  },
  warningText: { ...typography.body, color: colors.onWarningContainer, flex: 1 },
  selected: { marginHorizontal: spacing.md, marginBottom: spacing.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.lg },
  grow: { flexGrow: 1 },
  hint: { ...typography.caption, color: colors.onSurfaceVariant, marginTop: spacing.sm },
});
