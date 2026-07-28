FROM php:8.2-cli-alpine

WORKDIR /app

COPY . .

EXPOSE 8084

CMD ["php", "-S", "0.0.0.0:8084", "-t", "public"]
