import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GeoPoint } from '../../common/schemas/geo-point.schema';

const REQUEST_TIMEOUT_MS = 5_000;

/** The driven route between two points, as Google returns it. */
export interface DrivingRoute {
  /** Google's encoded polyline — decoded by the client into map points. */
  polyline: string;
  distanceMeters: number;
  durationSeconds: number;
}

/**
 * Fetches the road-following route from the driver to the delivery
 * destination (spec 005 — the tracking map previously drew a straight line
 * between the two, which crosses blocks the truck cannot).
 *
 * Called server-side, not from the app: Directions is a web service, and a
 * key restricted to iOS/Android bundle IDs — which the mobile Maps key must
 * be — is rejected for it. The backend already holds an unrestricted key for
 * reverse geocoding, so the same one serves here.
 *
 * Degrades to `undefined` rather than throwing on every failure path. A
 * missing route costs the client a nicer line; it must never cost them the
 * tracking screen.
 */
@Injectable()
export class RouteService {
  private readonly logger = new Logger(RouteService.name);

  constructor(private readonly config: ConfigService) {}

  async drivingRoute(from: GeoPoint, to: GeoPoint): Promise<DrivingRoute | undefined> {
    const apiKey = this.config.get<string>('geocoding.googleMapsApiKey');
    if (!apiKey) {
      this.logger.warn('GOOGLE_MAPS_API_KEY not configured — skipping route lookup');
      return undefined;
    }

    // GeoJSON stores [lng, lat]; Directions wants "lat,lng".
    const [fromLng, fromLat] = from.coordinates;
    const [toLng, toLat] = to.coordinates;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
      url.searchParams.set('origin', `${fromLat},${fromLng}`);
      url.searchParams.set('destination', `${toLat},${toLng}`);
      url.searchParams.set('mode', 'driving');
      url.searchParams.set('key', apiKey);

      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        this.logger.warn(`Directions API returned HTTP ${response.status}`);
        return undefined;
      }

      const body = (await response.json()) as {
        status: string;
        routes?: Array<{
          overview_polyline?: { points?: string };
          legs?: Array<{ distance?: { value: number }; duration?: { value: number } }>;
        }>;
      };

      // ZERO_RESULTS is a legitimate answer (an unreachable destination), not
      // an error to shout about — anything else is worth a line in the log.
      if (body.status !== 'OK') {
        if (body.status !== 'ZERO_RESULTS') {
          this.logger.warn(`Directions API status ${body.status}`);
        }
        return undefined;
      }

      const route = body.routes?.[0];
      const points = route?.overview_polyline?.points;
      const leg = route?.legs?.[0];
      if (!points || !leg?.distance || !leg?.duration) {
        return undefined;
      }

      return {
        polyline: points,
        distanceMeters: leg.distance.value,
        durationSeconds: leg.duration.value,
      };
    } catch (error) {
      // Includes the abort above — a slow upstream must not hold the client's
      // tracking request open.
      this.logger.warn(`Directions lookup failed: ${(error as Error).message}`);
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }
}
