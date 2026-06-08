[build]
  publish = "."

[functions]
  node_bundler = "esbuild"

# v13: lift Claude meal-plan + import out of the default 10s timeout.
# Up to 26s is allowed on Netlify Pro plans; Free plans cap at 10s regardless of this setting.
[functions."claude"]
  timeout = 26

[functions."import"]
  timeout = 26

[functions."prices"]
  timeout = 26

[[headers]]
  for = "/*"
  [headers.values]
    X-Frame-Options = "DENY"
    X-Content-Type-Options = "nosniff"
    Referrer-Policy = "strict-origin-when-cross-origin"
    # Allow localStorage and all CDN scripts the app needs
    Content-Security-Policy = "default-src 'self' 'unsafe-inline' 'unsafe-eval' https: data: blob:; connect-src 'self' https: wss:; img-src 'self' data: blob: https:;"
    Cache-Control = "public, max-age=0, must-revalidate"

[functions."composio"]
  timeout = 26

[functions."pantry"]
  timeout = 26
