# Component & Responsive Design Specifications

Font: `Inter` (open-source) | Icons: `Lucide` (MIT)
Viewports: Desktop `1280x800` | Mobile `390x844` (zero horizontal overflow)

## 1. Responsive Layout Shell
- **Desktop (`>= 768px`):** Fixed 248px left `Sidebar` + 56px `TopBar` + fluid main content (`100dvh` for Inbox/Kanban).
- **Mobile (`390x844`):**
  - Hidden desktop sidebar; compact 56px `TopBar` with org badge, alerts bell, and menu trigger.
  - Fixed 64px `BottomNav` with 5 primary destinations (`Inbox`, `Kanban`, `Contacts`, `AI`, `More` sheet), minimum `44x44px` touch targets, `env(safe-area-inset-bottom)` support.
  - `overflow-x: hidden` on root shell; all tables/kanban/inbox use responsive cards, stage tabs, or bottom sheets.

## 2. Core Components

### Button
- Variants: `primary` (`bg-accent text-on-accent`), `secondary` (`bg-surface border`), `ghost`, `danger` (`bg-danger text-on-danger`).
- Sizes: `sm` (32px), `md` (40px), `lg` (48px, mobile CTA).
- States: default, hover, active, focus-visible (2px ring), disabled, loading.

### Inbox (`S06`)
- **Desktop (`1280x800`):** 3-column grid (`320px` ConversationList | `1fr` ChatThread | `340px` CRMSidePanel).
- **Mobile (`390x844`):** 2-step view (List -> full-screen Thread with Back button). Customer 360° opens in a bottom `Sheet` triggered from the header info icon.

### Kanban Board (`S11`)
- **Desktop (`1280x800`):** Horizontal stage columns (`300px` wide) with drag-and-drop & fractional indexing.
- **Mobile (`390x844`):** Stage selector tabs/pills at top + vertical card stack for the active stage + quick "Move Stage" action sheet on each card (avoids horizontal scroll and awkward touch-drag).

### Dialog / Sheet
- **Desktop:** Centered modal (`max-w-lg`, `radius-lg`, `shadow-pop`).
- **Mobile:** Bottom `Sheet` (`rounded-t-2xl`, max-height `88dvh`, scrollable body).

### Badges & Status
- Channel status: `WORKING` (success), `SCAN_QR_CODE` (warning), `FAILED` (danger).
- Conversation status: `ai_handling` (accent), `pending` (warning), `claimed` (success), `resolved` (muted).
