/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['monaco-editor'],
};

module.exports = nextConfig;
