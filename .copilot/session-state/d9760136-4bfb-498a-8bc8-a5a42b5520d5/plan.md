# Platform UI Overhaul — Azure/Vercel-Style + Bug Fixes

## Problem Statement
1. **Critical Bug**: Port Routing wizard "Next" button invisible on mobile (CSS grid overflow → flex fix + auto-advance)
2. **Navigation**: 40+ items → reduce cognitive load (Hick's Law / Miller's Law)
3. **Applications**: Catalog + Community separate → unified App Nav Tabs header
4. **Mock Data**: Several endpoints return mock without labeling
5. **Security**: 3 unprotected API routes
6. **UI/UX**: Azure/Vercel-style overhaul
7. **Testing**: Interactive test suite
8. **Community Apps**: Post-deploy status unclear

## Research Findings Applied
- Miller's Law: max 7 items per group
- Hick's Law: reduce visible choices
- NNGroup: reduce clutter without reducing capability
- Azure Portal: hub pages, favorites, all-services discovery
- Vercel/Railway: status badges, inline actions, clean cards
- Mobile-first: sticky footers, safe-area padding, auto-advance flows

## Phases
1. Critical bug fix (Port Routing wizard)
2. Navigation restructure (new groups, collapsed by default)
3. App Navigation Tabs (shared header linking apps/catalog/community)
4. Mock data labeling
5. Security hardening (auth on health routes)
6. Interactive tests page
7. Community apps improvements
8. Deploy + test
