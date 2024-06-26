{
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    nixpkgs-stable.url = "github:nixos/nixpkgs/24.05";
    flake-parts.url = "github:hercules-ci/flake-parts";
    systems.url = "github:nix-systems/default";
    process-compose-flake.url = "github:Platonic-Systems/process-compose-flake";
    services-flake.url = "github:juspay/services-flake";
  };
  outputs = inputs @ {flake-parts, ...}:
    flake-parts.lib.mkFlake {inherit inputs;} {
      systems = import inputs.systems;
      imports = [
        inputs.process-compose-flake.flakeModule
      ];
      perSystem = {
        self',
        pkgs,
        system,
        ...
      }: let
        stable = inputs.nixpkgs-stable.legacyPackages.${system};
      in {
        process-compose."default" = {config, ...}: {
          imports = [
            inputs.services-flake.processComposeModules.default
          ];

          services.tempo.tempo.enable = true;
          services.grafana.grafana = {
            enable = true;
            package = stable.grafana;
            http_port = 4000;
            extraConf = {
              "auth.anonymous" = {
                enabled = true;
                org_role = "Editor";
              };
            };
            datasources = with config.services.tempo.tempo; [
              {
                name = "Tempo";
                type = "tempo";
                access = "proxy";
                url = "http://${httpAddress}:${builtins.toString httpPort}";
              }
            ];
          };

          settings.processes.tsx = {
            command = "tsx --env-file=.env src/main-node.ts";
          };
        };

        devShells.default = pkgs.mkShell {
          nativeBuildInputs = with pkgs; [
            alejandra
            bun
            corepack
            nodejs_22
          ];
        };
      };
    };
}
