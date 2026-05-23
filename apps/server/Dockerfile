FROM golang:1.26-alpine AS build
WORKDIR /src
COPY apps/server/go.mod apps/server/go.sum* ./
RUN go mod download
COPY apps/server ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /out/phone-levelg-server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /
COPY --from=build /out/phone-levelg-server /phone-levelg-server
EXPOSE 4000
USER nonroot:nonroot
ENTRYPOINT ["/phone-levelg-server"]
