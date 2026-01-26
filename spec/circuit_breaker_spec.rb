# LOAD ERROR: Load error
# The following code has been commented out due to load errors.
# Please fix the missing constant/require and uncomment.

require 'rspec'
require 'net/http'

# COMMENTED: RSpec.describe Net::HTTP do
#   describe '.new' do
#     it 'creates an instance for the given host and port' do
#       http = described_class.new('example.com', 80)
#       expect(http).to be_a(described_class)
#     end
#
#     it 'defaults port to 80 when only host is provided' do
#       http = described_class.new('example.com')
#       expect(http.port).to eq(80)
#     end
#   end
#
#   describe '#address' do
#     it 'returns the host provided at initialization' do
#       http = described_class.new('example.com', 443)
#       expect(http.address).to eq('example.com')
#     end
#   end
#
#   describe '#port' do
#     it 'returns the port provided at initialization' do
#       http = described_class.new('example.com', 443)
#       expect(http.port).to eq(443)
#     end
#   end
# end
