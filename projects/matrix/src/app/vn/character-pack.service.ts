import { Injectable, inject } from '@angular/core';
import { MatrixService } from '../matrix.service';

/** The MSC2545 account-data type B1 #89 registers an active VN sticker pack at. */
export const USER_EMOTES_TYPE = 'im.ponies.user_emotes';

/** One image entry in an MSC2545 `im.ponies.user_emotes` pack. */
export interface PackImage {
  /** The sticker mxc:// URL (required — entries without a url are dropped). */
  url: string;
  /** Human-readable description / fallback text. */
  body?: string;
  /** MSC2545 usage hints: `emoticon` and/or `sticker`. Absent ⇒ both apply. */
  usage?: string[];
}

/** Pack-level metadata (MSC2545 `pack` object). */
export interface PackInfo {
  display_name?: string;
  avatar_url?: string;
  usage?: string[];
  attribution?: string;
}

/**
 * A parsed MSC2545 `im.ponies.user_emotes` pack: shortcode → image. For a VN
 * character the shortcodes ARE the canonical {@link Expression} labels B1 stamps
 * (`neutral`, `happy`, …), so {@link CharacterPackService.imageFor} can look up
 * the frame for the current expression directly.
 */
export interface UserEmotesPack {
  images: Record<string, PackImage>;
  pack: PackInfo;
}

/** A cache row: the resolved pack (or null = no pack) + when it was fetched. */
interface CacheEntry {
  pack: UserEmotesPack | null;
  fetchedAt: number;
}

/**
 * Resolves a room participant's ACTIVE VN-character sticker pack — the MSC2545
 * `im.ponies.user_emotes` account-data B1 #89 registers — so the live-render
 * panel can pick the sticker frame for the current expression.
 *
 * Reads through {@link MatrixService.getAccountData} (HttpOnly `bff_`-cookie /
 * brokered-token auth; no browser bearer), parses the standard MSC2545 shape,
 * and CACHES per-userId with a short TTL so a burst of messages from the same
 * sender does not refetch per message. FAIL-SOFT by construction: any error, a
 * missing pack, or a pack with no usable images resolves to `null` (the panel
 * then renders NOTHING — no character, no layout break) and never throws.
 */
@Injectable({ providedIn: 'root' })
export class CharacterPackService {
  private readonly matrix = inject(MatrixService);

  /** Short per-userId TTL — long enough to absorb a message burst, short enough
   *  that a sender swapping their active character is picked up promptly. */
  private readonly ttlMs = 60_000;
  private readonly cache = new Map<string, CacheEntry>();
  /** De-dupes concurrent in-flight resolves for the same userId. */
  private readonly inFlight = new Map<string, Promise<UserEmotesPack | null>>();

  /**
   * Resolve the owner's active VN sticker pack, cached per-userId for {@link
   * ttlMs}. Returns `null` (never throws) when there is no pack, the account-data
   * is unreadable, or the pack carries no usable images.
   */
  async resolveCharacterPack(userId: string): Promise<UserEmotesPack | null> {
    if (!userId) {
      return null;
    }
    const now = Date.now();
    const hit = this.cache.get(userId);
    if (hit && now - hit.fetchedAt < this.ttlMs) {
      return hit.pack;
    }
    const pending = this.inFlight.get(userId);
    if (pending) {
      return pending;
    }
    const p = this.fetchAndParse(userId)
      .then((pack) => {
        this.cache.set(userId, { pack, fetchedAt: Date.now() });
        return pack;
      })
      .catch(() => {
        // Fail-soft: cache the null so we don't hammer the homeserver each message.
        this.cache.set(userId, { pack: null, fetchedAt: Date.now() });
        return null;
      })
      .finally(() => {
        this.inFlight.delete(userId);
      });
    this.inFlight.set(userId, p);
    return p;
  }

  /** Pick the sticker mxc for `expression`, falling back to the literal
   *  `neutral` frame when the requested expression is absent; `null` if neither
   *  exists. */
  imageFor(pack: UserEmotesPack | null, expression: string): PackImage | null {
    if (!pack) {
      return null;
    }
    return pack.images[expression] ?? pack.images['neutral'] ?? null;
  }

  /** Drop the cached row for a user (e.g. after a known character change). */
  invalidate(userId: string): void {
    this.cache.delete(userId);
  }

  /** Fetch the raw account-data and parse it into a normalised pack, or null. */
  private async fetchAndParse(userId: string): Promise<UserEmotesPack | null> {
    const raw = await this.matrix.getAccountData<Record<string, unknown>>(userId, USER_EMOTES_TYPE);
    return this.parse(raw);
  }

  /**
   * Parse a raw `im.ponies.user_emotes` content into a normalised pack. Tolerant
   * of the spec's variations: drops image entries without a `mxc://` url, accepts
   * a missing `pack` object, and returns `null` when no usable image survives.
   */
  private parse(raw: Record<string, unknown> | null): UserEmotesPack | null {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const rawImages = raw['images'];
    if (!rawImages || typeof rawImages !== 'object') {
      return null;
    }
    const images: Record<string, PackImage> = {};
    for (const [shortcode, value] of Object.entries(rawImages as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') {
        continue;
      }
      const url = (value as Record<string, unknown>)['url'];
      if (typeof url !== 'string' || !url.startsWith('mxc://')) {
        continue;
      }
      const body = (value as Record<string, unknown>)['body'];
      const usage = (value as Record<string, unknown>)['usage'];
      images[shortcode] = {
        url,
        body: typeof body === 'string' ? body : undefined,
        usage: Array.isArray(usage) ? usage.filter((u): u is string => typeof u === 'string') : undefined,
      };
    }
    if (Object.keys(images).length === 0) {
      return null;
    }
    const rawPack = raw['pack'];
    const pack: PackInfo =
      rawPack && typeof rawPack === 'object' ? (rawPack as PackInfo) : {};
    return { images, pack };
  }
}
