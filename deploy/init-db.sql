\getenv app_password HWFORAI_DB_PASSWORD

CREATE ROLE hwforai_app LOGIN PASSWORD :'app_password';
ALTER DATABASE hwforai OWNER TO hwforai_app;
REVOKE CONNECT ON DATABASE hwforai FROM PUBLIC;
