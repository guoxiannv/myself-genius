import React from 'react';
import Svg, { Path } from 'react-native-svg';

type IconProps = { color?: string; size?: number; strokeWidth?: number };
type IconDefinition = { paths: string[] };

function icon(definition: IconDefinition) {
  return function InlineIcon({ color = '#756B8A', size = 20, strokeWidth = 2.2 }: IconProps) {
    return <Svg accessibilityElementsHidden height={size} viewBox="0 0 24 24" width={size}>
      {definition.paths.map((d, index) => <Path d={d} fill="none" key={`p-${index}`} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={strokeWidth} />)}
    </Svg>;
  };
}

// Harmony Go reliably renders these Lucide-style icons as Path-only geometry.
// Encode circles, lines, and rectangles as path commands when extending this file.
export const HomeIcon = icon({ paths: ['M4 11 12 4l8 7 M6 10v10h12V10 M9 20v-6h6v6'] });
export const DashboardIcon = icon({ paths: ['M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z'] });
export const CalendarIcon = icon({ paths: ['M4 5h16v16H4z M4 10h16 M8 3v4 M16 3v4'] });
export const UserIcon = icon({ paths: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M4 21c0-4 4-6 8-6s8 2 8 6'] });
export const PlusIcon = icon({ paths: ['M12 5v14 M5 12h14'] });
export const CheckIcon = icon({ paths: ['M4 12l5 5L20 6'] });
export const ClockIcon = icon({ paths: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 7v5l3 2'] });
export const AlertIcon = icon({ paths: ['M12 3 2 20h20Z M12 10v4 M12 17h.01'] });
export const EditIcon = icon({ paths: ['M12 20h9 M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z'] });
export const TrashIcon = icon({ paths: ['M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 11v6 M14 11v6'] });
export const DownloadIcon = icon({ paths: ['M12 3v12 M7 10l5 5 5-5 M5 21h14'] });
export const UploadIcon = icon({ paths: ['M12 21V9 M7 14l5-5 5 5 M5 3h14'] });
export const SettingsIcon = icon({ paths: ['M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z'] });
export const BookIcon = icon({ paths: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5Z M4 6.5v13 M8 7h8'] });
export const ChevronRightIcon = icon({ paths: ['M9 18l6-6-6-6'] });
export const ChevronLeftIcon = icon({ paths: ['M15 18l-6-6 6-6'] });
export const MoreIcon = icon({ paths: ['M5 12h.01 M12 12h.01 M19 12h.01'] });
