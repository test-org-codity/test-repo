require 'rspec'
require 'net/http'

RSpec.describe Net::HTTP do
  describe '.new' do
    it 'creates an instance for the given host and port' do
      http = described_class.new('example.com', 80)
      expect(http).to be_a(described_class)
      expect(http.address).to eq('example.com')
      expect(http.port).to eq(80)
    end

    it 'defaults port to Net::HTTP.default_port when only host is provided' do
      http = described_class.new('example.com')
      expect(http.port).to eq(described_class.default_port)
    end

    it 'coerces nil host to an empty string and defaults port to Net::HTTP.default_port when no port is provided' do
      http = described_class.new(nil)
      expect(http.address).to eq('')
      expect(http.port).to eq(described_class.default_port)
    end
  end

  describe '#address' do
    it 'returns the host provided at initialization' do
      http = described_class.new('example.com', 443)
      expect(http.address).to eq('example.com')
    end

    it 'returns an empty string if initialized with nil host' do
      http = described_class.new(nil)
      expect(http.address).to eq('')
    end
  end

  describe '#port' do
    it 'returns the port provided at initialization' do
      http = described_class.new('example.com', 443)
      expect(http.port).to eq(443)
    end

    it 'defaults port to Net::HTTP.default_port if initialized with nil host and no port' do
      http = described_class.new(nil)
      expect(http.port).to eq(described_class.default_port)
    end
  end
end
