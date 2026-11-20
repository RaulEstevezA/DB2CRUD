-- MySQL dump 10.13  Distrib 8.4.3, for Linux (x86_64)
--
-- Host: localhost    Database: shop
-- ------------------------------------------------------
-- Server version	8.4.3

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;

--
-- Table structure for table `categories`
--

DROP TABLE IF EXISTS `categories`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `categories` (
  `id` int unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(60) COLLATE utf8mb4_bin NOT NULL,
  `parent_id` int unsigned DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_categories_name` (`name`),
  KEY `fk_categories_parent` (`parent_id`),
  CONSTRAINT `fk_categories_parent` FOREIGN KEY (`parent_id`) REFERENCES `categories` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=12 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='Groups of products';
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Table structure for table `products`
--

DROP TABLE IF EXISTS `products`;
CREATE TABLE `products` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `category_id` int unsigned NOT NULL,
  `sku` char(12) NOT NULL,
  `title` varchar(200) NOT NULL DEFAULT '',
  `price` decimal(10,2) NOT NULL DEFAULT '0.00',
  `active` tinyint(1) NOT NULL DEFAULT '1',
  `kind` enum('physical','digital') NOT NULL DEFAULT 'physical',
  `colors` set('red','blue') DEFAULT NULL,
  `details` json DEFAULT NULL,
  `picture` longblob,
  `rating` float DEFAULT NULL,
  `weight` double NOT NULL,
  `released` year DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT 'Last change',
  `slug` varchar(220) GENERATED ALWAYS AS (lower(`title`)) VIRTUAL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_products_sku` (`sku`),
  KEY `ix_products_category_title` (`category_id`,`title`(20)),
  FULLTEXT KEY `ft_products_title` (`title`),
  CONSTRAINT `fk_products_category` FOREIGN KEY (`category_id`) REFERENCES `categories` (`id`),
  CONSTRAINT `ck_products_price` CHECK ((`price` >= 0))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

DELIMITER ;;
/*!50003 CREATE*/ /*!50017 DEFINER=`root`@`%`*/ /*!50003 TRIGGER `products_touch` BEFORE UPDATE ON `products` FOR EACH ROW BEGIN
  SET NEW.title = TRIM(NEW.title);
END */;;
DELIMITER ;

/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;
-- Dump completed on 2026-11-20 12:00:00
