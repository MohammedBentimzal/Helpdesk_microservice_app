-- Runs once, the first time the MySQL container starts with an empty data volume.
-- helpdesk_auth is created by MYSQL_DATABASE; here we add the notification service's database.
CREATE DATABASE IF NOT EXISTS helpdesk_notifications;
GRANT ALL PRIVILEGES ON helpdesk_notifications.* TO 'helpdesk'@'%';
FLUSH PRIVILEGES;
