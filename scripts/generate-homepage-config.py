#!/usr/bin/env python3
"""
Generate Homepage values.yaml from platform.yaml source of truth.
Run after editing platform.yaml to regenerate the dashboard config.

Usage: python3 scripts/generate-homepage-config.py
"""

import yaml
import sys
import os

PLATFORM_YAML = os.path.join(os.path.dirname(__file__), '..', 'platform.yaml')
HOMEPAGE_VALUES = os.path.join(os.path.dirname(__file__), '..', 'kubernetes', 'platform', 'homepage', 'values.yaml')

# ── App registry ─────────────────────────────────────────────────────────────
# Maps app key → display config. Shown only when app is enabled.
CATALOG_APPS = {
    'wiki': {
        'name': 'Wiki.js',
        'href': 'https://wiki.int.rlservers.com',
        'description': 'Internal documentation & runbooks',
        'icon': 'wikijs.png',
        'ping': 'http://wiki.wiki.svc.cluster.local',
    },
    'gatus': {
        'name': 'Gatus',
        'href': 'https://status.rlservers.com',
        'description': 'Uptime & health monitoring',
        'icon': 'mdi-heart-pulse',
        'ping': 'http://gatus.gatus.svc.cluster.local:8080/health',
    },
    'stirling-pdf': {
        'name': 'Stirling PDF',
        'href': 'https://stirling-pdf.int.rlservers.com',
        'description': 'PDF manipulation & conversion',
        'icon': 'mdi-file-pdf-box',
        'ping': 'http://stirling-pdf.stirling-pdf.svc.cluster.local:8080',
    },
    'onedev': {
        'name': 'OneDev',
        'href': 'https://onedev.int.rlservers.com',
        'description': 'Self-hosted Git & CI/CD platform',
        'icon': 'mdi-git',
        'ping': 'http://onedev.onedev.svc.cluster.local:6610',
    },
    'infraweaver-console': {
        'name': 'InfraWeaver',
        'href': 'https://infraweaver.int.rlservers.com',
        'description': 'Platform management console',
        'icon': 'mdi-console',
        'ping': 'http://infraweaver-console.infraweaver-console.svc.cluster.local:3000/api/ping',
    },
    'registry': {
        'name': 'Container Registry',
        'href': 'https://registry.int.rlservers.com',
        'description': 'Private OCI/Docker image registry',
        'icon': 'mdi-package',
        'ping': 'http://registry.registry.svc.cluster.local:5000/v2/',
    },
    'uptime-kuma': {
        'name': 'Uptime Kuma',
        'href': 'https://uptime-kuma.int.rlservers.com',
        'description': 'Uptime monitoring',
        'icon': 'uptime-kuma.png',
        'ping': 'http://uptime-kuma.uptime-kuma.svc.cluster.local:3001',
    },
    'vaultwarden': {
        'name': 'Vaultwarden',
        'href': 'https://vaultwarden.int.rlservers.com',
        'description': 'Password manager (Bitwarden-compatible)',
        'icon': 'bitwarden.png',
        'ping': 'http://vaultwarden.vaultwarden.svc.cluster.local:80',
    },
    'gitea': {
        'name': 'Gitea',
        'href': 'https://gitea.int.rlservers.com',
        'description': 'Lightweight Git forge',
        'icon': 'gitea.png',
        'ping': 'http://gitea-http.gitea.svc.cluster.local:3000',
    },
    'n8n': {
        'name': 'N8N',
        'href': 'https://n8n.int.rlservers.com',
        'description': 'Workflow automation',
        'icon': 'n8n.png',
        'ping': 'http://n8n.n8n.svc.cluster.local:5678/healthz',
    },
    'excalidraw': {
        'name': 'Excalidraw',
        'href': 'https://excalidraw.int.rlservers.com',
        'description': 'Collaborative whiteboard',
        'icon': 'excalidraw.png',
    },
    'it-tools': {
        'name': 'IT-Tools',
        'href': 'https://it-tools.int.rlservers.com',
        'description': 'Developer utility tools',
        'icon': 'mdi-tools',
    },
    'actual': {
        'name': 'Actual Budget',
        'href': 'https://actual.int.rlservers.com',
        'description': 'Personal finance tracker',
        'icon': 'mdi-cash-multiple',
    },
    'immich': {
        'name': 'Immich',
        'href': 'https://immich.int.rlservers.com',
        'description': 'Photo backup & management',
        'icon': 'immich.png',
    },
    'mealie': {
        'name': 'Mealie',
        'href': 'https://mealie.int.rlservers.com',
        'description': 'Recipe manager',
        'icon': 'mealie.png',
    },
    'forgejo': {
        'name': 'Forgejo',
        'href': 'https://forgejo.int.rlservers.com',
        'description': 'Community Git forge',
        'icon': 'forgejo.png',
    },
    'jellyfin': {
        'name': 'Jellyfin',
        'href': 'https://jellyfin.int.rlservers.com',
        'description': 'Media server',
        'icon': 'jellyfin.png',
    },
    'paperless-ngx': {
        'name': 'Paperless',
        'href': 'https://paperless.int.rlservers.com',
        'description': 'Document management',
        'icon': 'paperless.png',
    },
}

def load_platform():
    with open(PLATFORM_YAML) as f:
        return yaml.safe_load(f)

def build_services(platform):
    """Build the services section based on enabled apps in platform.yaml."""
    enabled_catalog = set(platform.get('catalog', {}).get('enabled', []))
    groups = platform.get('groups', {})

    monitoring_enabled = groups.get('core-monitoring', {}).get('enabled', True)
    platform_enabled = groups.get('core-platform', {}).get('enabled', True)

    services = []

    # ── Infrastructure (always visible) ──────────────────────────────────────
    infra = {'Platform Infrastructure': [
        {'ArgoCD': {
            'href': 'https://argocd.int.rlservers.com',
            'description': 'GitOps — continuous delivery',
            'icon': 'argocd.png',
            'ping': 'http://argocd-server.argocd.svc.cluster.local',
        }},
        {'Traefik': {
            'href': 'https://traefik.int.rlservers.com',
            'description': 'Kubernetes ingress controller',
            'icon': 'traefik.png',
            'ping': 'http://traefik.traefik.svc.cluster.local:8080/ping',
        }},
        {'Longhorn': {
            'href': 'https://longhorn.int.rlservers.com',
            'description': 'Distributed block storage',
            'icon': 'longhorn.png',
            'ping': 'http://longhorn-frontend.longhorn-system.svc.cluster.local',
        }},
        {'OpenBao': {
            'href': 'https://openbao.int.rlservers.com',
            'description': 'Secrets & certificates vault',
            'icon': 'vault.png',
            'ping': 'http://openbao.openbao.svc.cluster.local:8200/v1/sys/health',
        }},
    ]}

    # Add monitoring if enabled
    if monitoring_enabled:
        infra['Platform Infrastructure'].append({'Grafana': {
            'href': 'https://grafana.int.rlservers.com',
            'description': 'Metrics & dashboards',
            'icon': 'grafana.png',
            'ping': 'http://grafana-apps.apps-grafana.svc.cluster.local',
        }})
        infra['Platform Infrastructure'].append({'Prometheus': {
            'href': 'https://prometheus.int.rlservers.com',
            'description': 'Metrics collection & alerting',
            'icon': 'prometheus.png',
            'ping': 'http://kube-prometheus-stack-prometheus.monitoring.svc.cluster.local:9090/-/healthy',
        }})
    services.append(infra)

    # ── Security & Identity ───────────────────────────────────────────────────
    if platform_enabled:
        security = {'Security & Identity': [
            {'Authentik': {
                'href': 'https://auth.rlservers.com',
                'description': 'Single sign-on (SSO) gateway',
                'icon': 'authentik.png',
                'ping': 'http://authentik-server.authentik.svc.cluster.local/-/health/ready/',
            }},
            {'NetBird VPN': {
                'href': 'https://netbird.int.rlservers.com',
                'description': 'Zero-trust WireGuard VPN mesh',
                'icon': 'netbird.png',
                'ping': 'http://netbird-management.netbird.svc.cluster.local/api/v1/health',
            }},
        ]}
        services.append(security)

    # ── Catalog Apps (dynamic from platform.yaml) ─────────────────────────────
    catalog_items = []
    # InfraWeaver Console first if enabled
    for app_key in ['infraweaver-console', 'wiki', 'gatus', 'onedev', 'stirling-pdf', 'registry']:
        if app_key in enabled_catalog and app_key in CATALOG_APPS:
            cfg = CATALOG_APPS[app_key].copy()
            name = cfg.pop('name')
            entry = {name: cfg}
            catalog_items.append(entry)

    # Any other enabled catalog apps not in the priority list above
    priority = {'infraweaver-console', 'wiki', 'gatus', 'onedev', 'stirling-pdf', 'registry'}
    for app_key in enabled_catalog:
        if app_key not in priority and app_key in CATALOG_APPS:
            cfg = CATALOG_APPS[app_key].copy()
            name = cfg.pop('name')
            catalog_items.append({name: cfg})

    if catalog_items:
        services.append({'Catalog Apps': catalog_items})

    # ── External Websites ─────────────────────────────────────────────────────
    services.append({'Websites': [
        {'rlservers.com': {
            'href': 'https://rlservers.com',
            'description': 'Main website',
            'icon': 'wordpress.png',
            'ping': 'https://rlservers.com',
        }},
        {'De Goudentijd': {
            'href': 'https://degoudentijd.rlservers.com',
            'description': 'WordPress site',
            'icon': 'wordpress.png',
            'ping': 'https://degoudentijd.rlservers.com',
        }},
        {'Feest in het Donker': {
            'href': 'https://feestinhetdonker.rlservers.com',
            'description': 'Event website',
            'icon': 'html5.png',
            'ping': 'https://feestinhetdonker.rlservers.com',
        }},
        {'yonavaarwater.nl': {
            'href': 'https://yonavaarwater.nl',
            'description': 'WordPress site',
            'icon': 'wordpress.png',
            'ping': 'https://yonavaarwater.nl',
        }},
        {'zonnevaarwater.nl': {
            'href': 'https://zonnevaarwater.nl',
            'description': 'WordPress site',
            'icon': 'wordpress.png',
            'ping': 'https://zonnevaarwater.nl',
        }},
    ]})

    return services

def build_layout(services):
    """Build layout sections matching the services groups."""
    icons = {
        'Platform Infrastructure': 'mdi-server-network',
        'Security & Identity': 'mdi-shield-lock',
        'Catalog Apps': 'mdi-apps',
        'Websites': 'mdi-web',
    }
    layout = {}
    for svc_group in services:
        for group_name in svc_group:
            layout[group_name] = {
                'icon': icons.get(group_name, 'mdi-application'),
                'style': 'row',
                'columns': 4,
            }
    return layout

def generate():
    platform = load_platform()
    services = build_services(platform)
    layout = build_layout(services)

    config = {
        'resources': {
            'requests': {'cpu': '50m', 'memory': '128Mi'},
            'limits': {'cpu': '200m', 'memory': '256Mi'},
        },
        'enableRbac': False,
        'serviceAccount': {'create': True, 'name': 'homepage'},
        'ingress': {'main': {'enabled': False}},
        'config': {
            'settings': {
                'title': 'InfraWeaver',
                'theme': 'dark',
                'color': 'cyan',
                'headerStyle': 'clean',
                'hideVersion': True,
                'disableCollapse': False,
                'target': '_blank',
                'language': 'nl',
                'layout': layout,
            },
            'widgets': [
                {'greeting': {'text_size': 'xl', 'text': 'InfraWeaver'}},
                {'datetime': {'text_size': 'l', 'format': {
                    'dateStyle': 'long', 'timeStyle': 'short', 'hour12': False,
                }}},
                {'search': {'provider': 'google', 'target': '_blank'}},
            ],
            'kubernetes': {'mode': 'disabled'},
            'docker': {},
            'bookmarks': [],
            'services': services,
        },
    }

    header = "# AUTO-GENERATED from platform.yaml — run scripts/generate-homepage-config.py to update\n"
    header += "# Homepage Helm values — Dashboard: https://home.int.rlservers.com\n\n"

    with open(HOMEPAGE_VALUES, 'w') as f:
        f.write(header)
        yaml.dump(config, f, allow_unicode=True, default_flow_style=False, sort_keys=False)

    print(f"✅ Generated {HOMEPAGE_VALUES}")
    enabled = platform.get('catalog', {}).get('enabled', [])
    print(f"   Catalog apps included: {enabled}")

if __name__ == '__main__':
    generate()
