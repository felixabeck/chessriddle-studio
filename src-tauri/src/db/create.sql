CREATE TABLE Info (
    Name TEXT UNIQUE NOT NULL,
    Value TEXT
);

CREATE TABLE Events (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT UNIQUE
);

CREATE TABLE Sites (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    Name TEXT UNIQUE
);

CREATE TABLE Players (
    ID INTEGER PRIMARY KEY,
    Name TEXT UNIQUE,
    Elo INTEGER
);

CREATE TABLE Games (
    ID INTEGER PRIMARY KEY AUTOINCREMENT,
    EventID INTEGER NOT NULL DEFAULT 0,
    SiteID INTEGER NOT NULL DEFAULT 0,
    Date TEXT,
    UTCTime TEXT,
    Round TEXT,
    WhiteID INTEGER NOT NULL DEFAULT 0,
    WhiteElo INTEGER,
    BlackID INTEGER NOT NULL DEFAULT 0,
    BlackElo INTEGER,
    WhiteMaterial INTEGER,
    BlackMaterial INTEGER,
    Result TEXT CHECK(Result IN ('1-0', '0-1', '1/2-1/2', '*') OR Result IS NULL),
    TimeControl TEXT,
    ECO TEXT,
    PlyCount INTEGER,
    FEN TEXT,
    Moves BLOB,
    PawnHome INTEGER NOT NULL DEFAULT 0,
    Orientation TEXT CHECK(Orientation IN ('white', 'black') OR Orientation IS NULL),
    FOREIGN KEY(EventID) REFERENCES Events(ID),
    FOREIGN KEY(SiteID) REFERENCES Sites(ID),
    FOREIGN KEY(WhiteID) REFERENCES Players(ID),
    FOREIGN KEY(BlackID) REFERENCES Players(ID)
);

INSERT INTO Players (ID, Name, Elo) VALUES (0, 'Unknown', NULL);
INSERT INTO Events (ID, Name) VALUES (0, 'Unknown');
INSERT INTO Sites (ID, Name) VALUES (0, 'Unknown');

CREATE TRIGGER protect_unknown_player_delete
BEFORE DELETE ON Players WHEN OLD.ID = 0
BEGIN SELECT RAISE(ABORT, 'cannot delete the Unknown player'); END;
CREATE TRIGGER protect_unknown_player_update
BEFORE UPDATE ON Players WHEN OLD.ID = 0
  AND (NEW.ID != 0 OR NEW.Name IS NOT 'Unknown' OR NEW.Elo IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'cannot modify the Unknown player'); END;
CREATE TRIGGER protect_unknown_event_delete
BEFORE DELETE ON Events WHEN OLD.ID = 0
BEGIN SELECT RAISE(ABORT, 'cannot delete the Unknown event'); END;
CREATE TRIGGER protect_unknown_event_update
BEFORE UPDATE ON Events WHEN OLD.ID = 0
  AND (NEW.ID != 0 OR NEW.Name IS NOT 'Unknown')
BEGIN SELECT RAISE(ABORT, 'cannot modify the Unknown event'); END;
CREATE TRIGGER protect_unknown_site_delete
BEFORE DELETE ON Sites WHEN OLD.ID = 0
BEGIN SELECT RAISE(ABORT, 'cannot delete the Unknown site'); END;
CREATE TRIGGER protect_unknown_site_update
BEFORE UPDATE ON Sites WHEN OLD.ID = 0
  AND (NEW.ID != 0 OR NEW.Name IS NOT 'Unknown')
BEGIN SELECT RAISE(ABORT, 'cannot modify the Unknown site'); END;
