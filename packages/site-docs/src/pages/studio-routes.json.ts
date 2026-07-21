import { PUBLISHED_STUDIO_ROUTES } from '../lib/site-routes';

export function GET(): Response {
  return Response.json({
    routes: PUBLISHED_STUDIO_ROUTES.map((route) => route.id),
  });
}
