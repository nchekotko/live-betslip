import { useEffect, useState } from 'react';

export type Route = 'slip' | 'ops';

export function parseRoute(hash: string): Route {
  return hash.replace(/^#\/?/, '').startsWith('ops') ? 'ops' : 'slip';
}

/** Two routes do not justify a router dependency: `#/` and `#/ops`. */
export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(typeof location === 'undefined' ? '' : location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
