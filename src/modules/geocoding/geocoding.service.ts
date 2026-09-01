import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Reverse-geocodes a dropped pin into a suggested address at client
 * registration (spec 004 FR-011) — the ONLY place this is called from;
 * order/read paths always use the stored `addressText` (FR-012).
 *
 * Failure is never fatal (FR-013): a missing API key, a network error, a
 * timeout, or Google returning no results all produce the same empty
 * suggestion rather than throwing, so account creation is never blocked by
 * an external dependency. Uses the platform's Node runtime `fetch` directly
 * — a single external call doesn't justify a new HTTP-client dependency.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(private readonly config: ConfigService) {}

  async reverseGeocode(lat: number, lng: number): Promise<{ addressText: string }> {
    const apiKey = this.config.get<string>('geocoding.googleMapsApiKey');
    if (!apiKey) {
      this.logger.warn('GOOGLE_MAPS_API_KEY not configured — skipping reverse geocode');
      return { addressText: '' };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.searchParams.set('latlng', `${lat},${lng}`);
      url.searchParams.set('key', apiKey);
      // Saudi addresses read naturally in Arabic; the result is only ever a
      // suggestion the client edits before saving (FR-011), never final.
      url.searchParams.set('language', 'ar');

      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        this.logger.warn(`Geocoding API returned HTTP ${response.status}`);
        return { addressText: '' };
      }

      const body = (await response.json()) as {
        status: string;
        results?: Array<{ formatted_address?: string }>;
      };
      const addressText = body.results?.[0]?.formatted_address;
      if (body.status !== 'OK' || !addressText) {
        return { addressText: '' };
      }
      return { addressText };
    } catch (error) {
      // Network failure, timeout (AbortError), or a malformed response body —
      // all resolve to "no suggestion" rather than propagate.
      this.logger.warn(`Reverse geocode failed: ${(error as Error).message}`);
      return { addressText: '' };
    } finally {
      clearTimeout(timeout);
    }
  }
}
