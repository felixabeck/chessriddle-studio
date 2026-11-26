import {
    BookBookmark,
    Brain,
    ChartNoAxesColumn,
    ChessKnight,
    ChevronRight,
    ChevronsRight,
    Clock4,
    Database,
    Dumbbell,
    Flame,
    Hourglass,
    Image,
    Info,
    Library,
    MessageSquarePlus,
    MessagesSquare,
    Puzzle,
    ScanSearch,
    Send,
    Settings,
    Tags,
    Trophy,
    User,
    Zap,
    type LucideIcon,
} from "lucide-react";

/**
 * One concept, one glyph. Every surface that shows a feature or section identity takes it from
 * here by concept name, so the same concept looks the same everywhere and two concepts never share
 * a glyph. `chessRiddle` names the ChessRiddle catalogue identity that shows the same glyph with the
 * same meaning; a glyph ChessRiddle uses for something else is not available here. Both rules are
 * enforced by `iconCatalog.test.ts`. DESIGN.md → Icon identities explains the split.
 */
interface EmojiIdentity {
    readonly glyph: string;
    readonly chessRiddle?: string;
}

export const EMOJI_IDENTITIES = {
    // Features and places
    analysis: { glyph: "🔍", chessRiddle: "common.magnifier" },
    play: { glyph: "🤺", chessRiddle: "nav.challenges" },
    puzzles: { glyph: "🧩", chessRiddle: "nav.puzzles" },
    trainOpenings: { glyph: "🏋️", chessRiddle: "nav.training" },
    repertoire: { glyph: "📖", chessRiddle: "puzzle_type.opening_blunder" },
    importGame: { glyph: "📥" },
    library: { glyph: "🗃️", chessRiddle: "nav.library" },
    tabsFiles: { glyph: "🗂️" },
    database: { glyph: "🗄️" },
    chessbaseImport: { glyph: "📦" },
    engine: { glyph: "🧠", chessRiddle: "common.brain" },
    gameReport: { glyph: "📊", chessRiddle: "nav.statistics" },
    onlineAccounts: { glyph: "🌐", chessRiddle: "common.globe" },
    account: { glyph: "👤", chessRiddle: "nav.profile" },
    coach: { glyph: "💬", chessRiddle: "common.chat" },
    browserExtension: { glyph: "🔗" },
    settings: { glyph: "⚙️", chessRiddle: "nav.settings" },
    keyboard: { glyph: "⌨️", chessRiddle: "common.keyboard" },
    sound: { glyph: "🔊", chessRiddle: "common.sound_on" },
    advanced: { glyph: "🧪", chessRiddle: "common.test_tube" },
    guideTopic: { glyph: "📄" },
    // Library contents and filters
    board: { glyph: "♟️", chessRiddle: "common.pawn" },
    game: { glyph: "♟️", chessRiddle: "common.pawn" },
    allFiles: { glyph: "🗂️", chessRiddle: "filter.all" },
    due: { glyph: "🔄", chessRiddle: "nav.practice_mistakes" },
    tournament: { glyph: "🏆", chessRiddle: "insights.trophy_cabinet" },
    otherFile: { glyph: "📜", chessRiddle: "common.scroll" },
    // Feedback types
    bug: { glyph: "🐛", chessRiddle: "common.bug" },
    suggestion: { glyph: "💡", chessRiddle: "common.idea" },
    praise: { glyph: "⭐", chessRiddle: "common.star" },
    otherFeedback: { glyph: "✉️", chessRiddle: "common.mail" },
    // Board and editing topics (Settings cards, shortcut groups)
    look: { glyph: "🎨", chessRiddle: "common.palette" },
    highlights: { glyph: "✨", chessRiddle: "common.sparkles" },
    movingPieces: { glyph: "🖱️", chessRiddle: "common.mouse" },
    arrowsDrawing: { glyph: "🖍️" },
    notation: { glyph: "📃" },
    navigating: { glyph: "↔️" },
    layoutSaving: { glyph: "📐" },
    panels: { glyph: "🪟" },
    editing: { glyph: "✏️", chessRiddle: "common.edit" },
    annotations: { glyph: "✍️", chessRiddle: "common.writing" },
} as const satisfies Record<string, EmojiIdentity>;

export type EmojiId = keyof typeof EMOJI_IDENTITIES;

/** The glyph for a concept. */
export function emojiOf(id: EmojiId): string {
    return EMOJI_IDENTITIES[id].glyph;
}

/**
 * Overlaps that predate the one-glyph rule and were kept deliberately (Felix, 2026-11-25). Any other
 * shared glyph fails the catalogue test.
 */
export const ACCEPTED_EMOJI_OVERLAPS: readonly { glyph: string; ids: readonly EmojiId[] }[] = [
    { glyph: "🗂️", ids: ["tabsFiles", "allFiles"] },
    { glyph: "♟️", ids: ["board", "game"] },
];

interface LucideIdentity {
    readonly icon: LucideIcon;
    readonly chessRiddle?: string;
}

/**
 * Lucide icons that stand for a feature or section (page tabs, board tab kinds, file types,
 * database sections, time controls). Surfaces import the named constant for their concept; action
 * and status icons (close, save, a settings gear on a button, an info alert) stay outside the
 * catalogue. Named constants keep unused icons out of the entry chunk.
 */
export const LibraryIcon: LucideIcon = Library;
export const PersonIcon: LucideIcon = User;
export const EngineIcon: LucideIcon = Brain;
export const GameIcon: LucideIcon = ChessKnight;
export const DatabaseIcon: LucideIcon = Database;
export const PuzzlesIcon: LucideIcon = Puzzle;
export const RepertoireIcon: LucideIcon = BookBookmark;
export const TournamentIcon: LucideIcon = Trophy;
export const SettingsIcon: LucideIcon = Settings;
export const GuideIcon: LucideIcon = Info;
/** Both AI chats: the Coach panel on the board and the Assistant panel. */
export const AiChatIcon: LucideIcon = MessagesSquare;
export const AnalysisIcon: LucideIcon = ScanSearch;
export const ReportIcon: LucideIcon = ChartNoAxesColumn;
export const FeedbackIcon: LucideIcon = MessageSquarePlus;
export const StreakIcon: LucideIcon = Flame;
/** Repertoire practice: the board panel's Practice tab. */
export const PracticeIcon: LucideIcon = Dumbbell;
/** A game's details and PGN tags: the board panel's Info tab. */
export const GameInfoIcon: LucideIcon = Tags;
/** A scoresheet photo under review: the board panel's Photo tab. */
export const ScoresheetPhotoIcon: LucideIcon = Image;
export const UltraBulletIcon: LucideIcon = ChevronsRight;
export const BulletIcon: LucideIcon = ChevronRight;
export const BlitzIcon: LucideIcon = Zap;
export const RapidIcon: LucideIcon = Hourglass;
export const ClassicalIcon: LucideIcon = Clock4;
export const CorrespondenceIcon: LucideIcon = Send;

/** Every lucide identity with its ChessRiddle meaning; read by the catalogue test, not by surfaces. */
export const LUCIDE_IDENTITIES = {
    library: { icon: LibraryIcon, chessRiddle: "collections" },
    person: { icon: PersonIcon, chessRiddle: "account" },
    engine: { icon: EngineIcon, chessRiddle: "thinkingTime" },
    game: { icon: GameIcon, chessRiddle: "board" },
    database: { icon: DatabaseIcon },
    puzzles: { icon: PuzzlesIcon, chessRiddle: "puzzles" },
    repertoire: { icon: RepertoireIcon },
    tournament: { icon: TournamentIcon, chessRiddle: "leaderboard" },
    settings: { icon: SettingsIcon, chessRiddle: "settings" },
    guide: { icon: GuideIcon, chessRiddle: "guide" },
    aiChat: { icon: AiChatIcon },
    analysis: { icon: AnalysisIcon },
    report: { icon: ReportIcon, chessRiddle: "statistics" },
    feedback: { icon: FeedbackIcon, chessRiddle: "feedback" },
    streak: { icon: StreakIcon, chessRiddle: "streak" },
    practice: { icon: PracticeIcon, chessRiddle: "training" },
    gameInfo: { icon: GameInfoIcon },
    scoresheetPhoto: { icon: ScoresheetPhotoIcon },
    ultraBullet: { icon: UltraBulletIcon },
    bullet: { icon: BulletIcon },
    blitz: { icon: BlitzIcon },
    rapid: { icon: RapidIcon },
    classical: { icon: ClassicalIcon },
    correspondence: { icon: CorrespondenceIcon },
} as const satisfies Record<string, LucideIdentity>;
