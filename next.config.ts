import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Middleware (logowanie do panelu) domyślnie ucina treść żądań powyżej 10 MB - a materiały (np. PDF-y) bywają większe.
    middlewareClientMaxBodySize: "64mb",
  },
};

export default nextConfig;
