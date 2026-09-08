'use client';

import { useEffect } from 'react';
import privacy from '@/config/privacy.json';

// Also cover links rendered from meeting notes, not just the built-in UI.
export function ExternalLinkGuard() {
  useEffect(() => {
    if (privacy.allowExternalLinks) return;

    const blockExternalLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element
        ? event.target.closest('a[href]')
        : null;
      const href = anchor?.getAttribute('href');
      if (!href) return;

      try {
        const url = new URL(href, window.location.href);
        if (url.origin === window.location.origin && ['http:', 'https:'].includes(url.protocol)) {
          return;
        }
      } catch {
        // Malformed navigation targets are blocked as well.
      }
      event.preventDefault();
      event.stopPropagation();
    };

    document.addEventListener('click', blockExternalLink, true);
    document.addEventListener('auxclick', blockExternalLink, true);
    return () => {
      document.removeEventListener('click', blockExternalLink, true);
      document.removeEventListener('auxclick', blockExternalLink, true);
    };
  }, []);

  return null;
}
