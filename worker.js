/**
 * Cloudflare Worker — SEO Meta Injector for notesug.com
 *
 * Deploy this at: Cloudflare Dashboard → Workers & Pages → Create Worker
 * Then add a route:  notesug.com/*  → this worker
 *
 * Environment variables to set in the Worker settings:
 *   API_BASE  =  https://your-api-domain.com   (your backend API, no trailing slash)
 *   SITE_URL  =  https://notesug.com
 */

const SITE_NAME    = 'NotesUG';
const DEFAULT_DESC = 'Download free past papers, notes, schemes of work and more for Ugandan schools. Free for everyone, no sign-up needed.';
const DEFAULT_IMG  = 'https://notesug.com/og-default.png';

// ── Helpers ───────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncate(str, max) {
  if (!str) return '';
  return str.length <= max ? str : str.slice(0, max - 1) + '…';
}

// ── Fetch resource from your API ──────────────────────────────────────────────

async function fetchResource(slug, apiBase) {
  try {
    const res = await fetch(`${apiBase}/api/resources/${slug}`, {
      headers: { 'User-Agent': 'NotesUG-Worker/1.0', 'Accept': 'application/json' },
      signal: AbortSignal.timeout(4000),
      cf: { cacheEverything: true, cacheTtl: 300 }, // Cloudflare caches the API response for 5 min
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.data || json;
  } catch {
    return null;
  }
}

// ── Build meta for each route type ───────────────────────────────────────────

async function getMeta(pathname, apiBase, siteUrl) {
  // Resource detail page
  const resourceMatch = pathname.match(/^\/resources\/([^/]+)\/?$/);
  if (resourceMatch) {
    const slug     = resourceMatch[1];
    const resource = await fetchResource(slug, apiBase);

    if (resource) {
      const titleParts = [resource.subject_name, resource.class_name, resource.year].filter(Boolean).join(' · ');
      const title      = truncate(
        titleParts ? `${resource.title} — ${titleParts} | ${SITE_NAME}` : `${resource.title} | ${SITE_NAME}`,
        70,
      );
      const description = truncate(
        [
          resource.description,
          resource.subject_name && resource.class_name ? `${resource.subject_name} for ${resource.class_name}.` : null,
          `${resource.download_count ?? 0} downloads. Free on NotesUG.`,
        ].filter(Boolean).join(' '),
        160,
      );

      const jsonLd = JSON.stringify({
        '@context':        'https://schema.org',
        '@type':           'DigitalDocument',
        name:              resource.title,
        description,
        url:               `${siteUrl}/resources/${slug}`,
        datePublished:     resource.published_at || resource.created_at,
        author:            resource.author_name ? { '@type': 'Person', name: resource.author_name } : undefined,
        inLanguage:        'en',
        educationalLevel:  resource.level_name   || undefined,
        about:             resource.subject_name  || undefined,
      });

      return {
        title,
        description,
        image:     resource.thumbnail_url || resource.preview_image || DEFAULT_IMG,
        canonical: `${siteUrl}/resources/${slug}`,
        jsonLd,
      };
    }
  }

  // Resources listing page
  if (pathname === '/resources' || pathname === '/resources/') {
    return {
      title:       `Free Educational Resources — ${SITE_NAME}`,
      description: 'Browse thousands of free past papers, notes, and teaching materials for Ugandan schools.',
      canonical:   `${siteUrl}/resources`,
    };
  }

  // Homepage
  if (pathname === '/' || pathname === '') {
    return {
      title:       `${SITE_NAME} — Free Study Materials for Ugandan Students`,
      description: DEFAULT_DESC,
      canonical:   siteUrl,
    };
  }

  // Everything else — generic defaults
  return {
    title:       `${SITE_NAME} — Free Study Materials for Ugandan Students`,
    description: DEFAULT_DESC,
    canonical:   `${siteUrl}${pathname}`,
  };
}

// ── Inject meta into HTML ─────────────────────────────────────────────────────

function injectMeta(html, meta) {
  const title       = esc(meta.title       || `${SITE_NAME} — Free Study Materials`);
  const description = esc(meta.description || DEFAULT_DESC);
  const image       = esc(meta.image       || DEFAULT_IMG);
  const canonical   = esc(meta.canonical   || '');

  let result = html
    .replaceAll('__META_TITLE__',     title)
    .replaceAll('__META_DESC__',      description)
    .replaceAll('__META_IMAGE__',     image)
    .replaceAll('__META_CANONICAL__', canonical);

  if (meta.jsonLd) {
    result = result.replace(
      '</head>',
      `<script type="application/ld+json">${meta.jsonLd}</script>\n</head>`,
    );
  }

  return result;
}

// ── Worker entry point ────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url      = new URL(request.url);
    const pathname = url.pathname;
    const apiBase  = env.API_BASE  || 'https://your-api-domain.com';
    const siteUrl  = env.SITE_URL  || 'https://notesug.com';

    // Pass through non-HTML requests (assets, API calls, etc.)
    const accept = request.headers.get('Accept') || '';
    const isAsset = /\.\w{2,5}$/.test(pathname);
    if (isAsset || pathname.startsWith('/api/')) {
      return fetch(request);
    }

    // Fetch the original HTML from Cloudflare's cache / origin
    const originalRes  = await fetch(request);
    const contentType  = originalRes.headers.get('Content-Type') || '';

    // Only process HTML responses
    if (!contentType.includes('text/html')) {
      return originalRes;
    }

    const html = await originalRes.text();

    // Resolve meta tags for this route
    const meta       = await getMeta(pathname, apiBase, siteUrl);
    const finalHtml  = injectMeta(html, meta);

    return new Response(finalHtml, {
      status:  originalRes.status,
      headers: {
        'Content-Type':  'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
        // Preserve any other headers from the original response
        ...Object.fromEntries(originalRes.headers),
        // Override content-type to ensure charset
        'Content-Type': 'text/html; charset=utf-8',
      },
    });
  },
};
