# Resolve the cloud collection + environment UIDs that repo-sync wrote into
# .postman/resources.yaml, and export them to $GITHUB_ENV for the Postman CLI
# run steps. The collection keys carry literal [Smoke]/[Contract] markers; the
# environment is keyed by its slug file name.
require "yaml"

config = YAML.load_file(".postman/resources.yaml") || {}
cloud = config.fetch("cloudResources", {})
collections = cloud.fetch("collections", {})
environments = cloud.fetch("environments", {})

smoke = collections.find { |path, _| path.include?("[Smoke]") }&.last
contract = collections.find { |path, _| path.include?("[Contract]") }&.last
environment = environments.find { |path, _| path.end_with?("/ci.postman_environment.json") }&.last \
  || environments.values.first

abort("Missing smoke collection UID in .postman/resources.yaml") unless smoke
abort("Missing contract collection UID in .postman/resources.yaml") unless contract
abort("Missing environment UID in .postman/resources.yaml") unless environment

File.open(ENV.fetch("GITHUB_ENV"), "a") do |f|
  f.puts("POSTMAN_SMOKE_COLLECTION_UID=#{smoke}")
  f.puts("POSTMAN_CONTRACT_COLLECTION_UID=#{contract}")
  f.puts("POSTMAN_ENVIRONMENT_UID=#{environment}")
end

puts "Resolved smoke=#{smoke} contract=#{contract} environment=#{environment}"
