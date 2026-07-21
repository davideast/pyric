import { studioStaticPaths } from '../lib/site-routes';

export function GET(): Response {
  return Response.json({
    routes: studioStaticPaths().map(({ params }) => params.studio),
  });
}
