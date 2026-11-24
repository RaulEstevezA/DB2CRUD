CREATE TABLE things (
  id uuid PRIMARY KEY DEFAULT uuid(),
  tiny tinyint NOT NULL,
  small smallint NOT NULL,
  medium mediumint,
  num int unsigned,
  big bigint NOT NULL,
  price decimal(10,2) NOT NULL,
  r float NOT NULL,
  d double,
  flag tinyint(1) NOT NULL DEFAULT 1,
  born date NOT NULL,
  opens time NOT NULL,
  at datetime(6) NOT NULL,
  at_ts timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  changed datetime DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  bin varbinary(50) NOT NULL,
  blobby blob,
  data json NOT NULL,
  feeling enum('sad', 'ok', 'very happy') NOT NULL,
  code char(5) NOT NULL,
  note text,
  long_note longtext,
  total decimal(12,2) GENERATED ALWAYS AS (price * 2) STORED
);
CREATE TABLE kinds (
  code varchar(10) NOT NULL,
  day date NOT NULL,
  label varchar(30),
  PRIMARY KEY (code, day)
);
CREATE TABLE `Order` (
  `Id` bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
  `user` varchar(40) NOT NULL,
  `group` int NOT NULL DEFAULT 0 CHECK (`group` >= 0),
  `customerName` varchar(60) NOT NULL UNIQUE,
  `class` text,
  `metadata` text,
  `date` date,
  `time` time,
  `text` varchar(20),
  `list` text,
  `str` varchar(10),
  `int` integer,
  `dueDate` date NOT NULL,
  `closesAt` time,
  `createdAt` datetime DEFAULT CURRENT_TIMESTAMP,
  kind_code varchar(10),
  kind_day date,
  thing_id uuid,
  `parentId` bigint unsigned,
  FOREIGN KEY (thing_id) REFERENCES things (id) ON DELETE SET NULL,
  FOREIGN KEY (`parentId`) REFERENCES `Order` (`Id`),
  FOREIGN KEY (kind_code, kind_day) REFERENCES kinds (code, day)
);
CREATE TABLE audit_entries (
  entry_no int AUTO_INCREMENT PRIMARY KEY,
  `orderId` bigint unsigned NOT NULL,
  message varchar(200) NOT NULL,
  FOREIGN KEY (`orderId`) REFERENCES `Order` (`Id`) ON DELETE CASCADE
);
CREATE TABLE empties (
  id bigint AUTO_INCREMENT PRIMARY KEY,
  note text
);
