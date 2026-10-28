import { pyric } from "@pyric/cli/vite";

export default {
  plugins: [pyric({ hosted: true })],
  server: { port: 5181, strictPort: true },
};
