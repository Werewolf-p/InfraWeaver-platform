/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  serverExternalPackages: ['monaco-editor', '@kubernetes/client-node'],
};

module.exports = nextConfig;
