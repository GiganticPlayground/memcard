#!/bin/bash

# Token Weaver Development Setup Script
# This script automates the complete development setup from OpenAPI spec to running local dev server

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Verbose mode flag
VERBOSE=true

# Print colored messages
print_info() {
    echo -e "${BLUE}ℹ ${1}${NC}"
}

print_success() {
    echo -e "${GREEN}✓ ${1}${NC}"
}

print_error() {
    echo -e "${RED}✗ ${1}${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠ ${1}${NC}"
}

print_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${CYAN}  → ${1}${NC}"
    fi
}

print_header() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  ${1}${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════${NC}"
    echo ""
}

# Cleanup function to kill background processes on exit
cleanup() {
    if [ -n "$DEV_SERVER_PID" ]; then
        print_verbose "Cleaning up background processes..."
        kill $DEV_SERVER_PID 2>/dev/null || true
    fi
}

trap cleanup EXIT

# Start of setup
print_header "Token Weaver Development Setup"

# Step 1: Validate OpenAPI spec exists
print_info "Step 1: Validating OpenAPI specification..."
print_verbose "Looking for api/openapi.yaml"

if [ ! -f "api/openapi.yaml" ]; then
    print_error "OpenAPI specification not found!"
    echo ""
    echo "The development setup requires an OpenAPI specification file."
    echo "Expected location: ${YELLOW}api/openapi.yaml${NC}"
    echo ""
    echo "Please create your OpenAPI specification first:"
    echo "  1. Create the api/ directory if it doesn't exist:"
    echo "     ${CYAN}mkdir -p api${NC}"
    echo ""
    echo "  2. Add your OpenAPI specification file:"
    echo "     ${CYAN}touch api/openapi.yaml${NC}"
    echo ""
    echo "  3. Or copy an existing specification:"
    echo "     ${CYAN}cp your-api-spec.yaml api/openapi.yaml${NC}"
    echo ""
    exit 1
fi

print_success "Found OpenAPI specification: api/openapi.yaml"
print_verbose "Specification file is ready for code generation"
echo ""

# Step 2: Check and install dependencies
print_info "Step 2: Checking dependencies..."

if [ ! -d "node_modules" ] || [ "package-lock.json" -nt "node_modules" ]; then
    print_verbose "node_modules missing or outdated, installing dependencies..."
    print_info "Running: npm install"

    if npm install; then
        print_success "Dependencies installed successfully"
    else
        print_error "Failed to install dependencies"
        exit 1
    fi
else
    print_success "Dependencies are up to date"
    print_verbose "Skipping npm install"
fi
echo ""

# Step 3: Setup API keys configuration
print_info "Step 3: Setting up API keys configuration..."
print_verbose "Checking for config/api-keys.json"

if [ ! -d "config" ]; then
    print_verbose "Creating config directory"
    mkdir -p config
fi

if [ ! -f "config/api-keys.json" ]; then
    if [ -f "src/auth/api-keys.json.example" ]; then
        print_verbose "Creating config/api-keys.json from example"
        cat > config/api-keys.json <<'EOF'
{
  "apiKeys": {
    "dev-local-key-12345": {
      "name": "Local Development Key",
      "description": "Default API key for local development - DO NOT USE IN PRODUCTION",
      "createdAt": "2024-01-01T00:00:00Z",
      "active": true
    }
  }
}
EOF
        print_success "Created config/api-keys.json with development key"
    else
        print_warning "src/auth/api-keys.json.example not found"
    fi
else
    print_success "API keys configuration already exists"
    print_verbose "Using existing config/api-keys.json"
fi
echo ""

# Step 4: Create .env file if it doesn't exist
print_info "Step 4: Setting up environment configuration..."

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        print_verbose "Creating .env from .env.example"
        cp .env.example .env
        print_success "Created .env file from .env.example"
        print_warning "Please review and update .env with your configuration"
    else
        print_warning ".env.example not found, skipping .env creation"
    fi
else
    print_success ".env file already exists"
    print_verbose "Using existing environment configuration"
fi
echo ""

# Step 4: Generate TypeScript types
print_header "Code Generation"
print_info "Step 4a: Generating TypeScript types from OpenAPI spec..."
print_verbose "Running: npm run gen-types"

if npm run gen-types; then
    print_success "TypeScript types generated successfully"
    print_verbose "Types available at: src/types/schema.d.ts"
else
    print_error "Failed to generate TypeScript types"
    exit 1
fi
echo ""

# Step 5: Generate controller scaffolds
print_info "Step 4b: Generating controller scaffolds..."
print_verbose "Running: npm run gen-controllers"

if npm run gen-controllers; then
    print_success "Controllers generated successfully"
    print_verbose "Controllers available in: src/controllers/"
else
    print_error "Failed to generate controllers"
    exit 1
fi
echo ""

# Step 6: Check if port 3000 is available
print_info "Step 5: Checking port availability..."
print_verbose "Checking if port 3000 is available"

if lsof -Pi :3000 -sTCP:LISTEN -t >/dev/null 2>&1; then
    print_warning "Port 3000 is already in use"
    echo ""
    echo "Another process is using port 3000. Options:"
    echo "  1. Stop the process using port 3000:"
    echo "     ${CYAN}lsof -ti:3000 | xargs kill${NC}"
    echo ""
    echo "  2. Or change the PORT in your .env file"
    echo ""

    read -p "Do you want to continue anyway? (y/N) " -n 1 -r
    echo ""
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        print_info "Setup cancelled"
        exit 0
    fi
else
    print_success "Port 3000 is available"
fi
echo ""

# Step 7: Start development server
print_header "Starting Development Server"
print_info "Step 6: Starting local development server with hot-reload..."
print_verbose "Running: npm run dev"
echo ""
print_info "Starting server in background..."

# Create a temporary log file
LOG_FILE=$(mktemp)
print_verbose "Logs will be written to: $LOG_FILE"

# Start the dev server in the background and capture its PID
npm run dev > "$LOG_FILE" 2>&1 &
DEV_SERVER_PID=$!

print_verbose "Server process started (PID: $DEV_SERVER_PID)"

# Wait for server to be ready
print_info "Waiting for server to be ready..."
MAX_ATTEMPTS=30
ATTEMPT=0
SERVER_READY=false

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s http://localhost:3000/health > /dev/null 2>&1; then
        SERVER_READY=true
        break
    fi

    # Check if process is still running
    if ! kill -0 $DEV_SERVER_PID 2>/dev/null; then
        print_error "Server process died unexpectedly"
        echo ""
        echo "Last log output:"
        tail -n 20 "$LOG_FILE"
        rm "$LOG_FILE"
        exit 1
    fi

    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
    printf "."
done

echo ""

if [ "$SERVER_READY" = true ]; then
    print_success "Server is ready and responding"
else
    print_error "Server failed to start within timeout"
    echo ""
    echo "Check the logs at: $LOG_FILE"
    exit 1
fi

# Clean up log file
rm "$LOG_FILE"
echo ""

# Step 8: Open browser
print_info "Step 7: Opening Swagger UI in browser..."

# Detect OS and open browser
if command -v xdg-open > /dev/null; then
    print_verbose "Detected Linux, using xdg-open"
    xdg-open "http://localhost:3000/api-docs" > /dev/null 2>&1 &
elif command -v open > /dev/null; then
    print_verbose "Detected macOS, using open"
    open "http://localhost:3000/api-docs"
elif command -v start > /dev/null; then
    print_verbose "Detected Windows, using start"
    start "http://localhost:3000/api-docs"
else
    print_warning "Could not detect browser command"
    echo "Please manually open: http://localhost:3000/api-docs"
fi

print_success "Swagger UI should open in your browser"
echo ""

# Final success message
print_header "Development Setup Complete!"
echo ""
echo -e "${GREEN}🚀 Your development server is now running!${NC}"
echo ""
echo "Access your API at:"
echo -e "  ${BLUE}API Endpoint:${NC}  http://localhost:3000"
echo -e "  ${BLUE}Swagger UI:${NC}    http://localhost:3000/api-docs"
echo -e "  ${BLUE}Health Check:${NC}  http://localhost:3000/health"
echo ""
echo -e "${GREEN}🔑 API Authentication:${NC}"
echo -e "  ${YELLOW}Dev API Key:${NC}  dev-local-key-12345"
echo -e "  ${CYAN}Header Name:${NC}  X-API-Key"
echo ""
echo "Example curl command (protected endpoint):"
echo -e "  ${CYAN}curl -H \"X-API-Key: dev-local-key-12345\" http://localhost:3000/users${NC}"
echo ""
echo "Testing in Swagger UI:"
echo -e "  1. Click the ${YELLOW}🔓 Authorize${NC} button"
echo -e "  2. Enter: ${YELLOW}dev-local-key-12345${NC}"
echo -e "  3. Click ${YELLOW}Authorize${NC} and ${YELLOW}Close${NC}"
echo -e "  4. Test endpoints interactively"
echo ""
echo "Development features:"
echo -e "  ${GREEN}✓${NC} API key authentication enabled"
echo -e "  ${GREEN}✓${NC} Hot-reload enabled (nodemon watching for changes)"
echo -e "  ${GREEN}✓${NC} TypeScript types auto-generated from OpenAPI spec"
echo -e "  ${GREEN}✓${NC} Request/response validation active"
echo -e "  ${GREEN}✓${NC} Interactive API documentation available"
echo ""
echo "Useful commands:"
echo -e "  ${YELLOW}npm run dev${NC}              - Restart development server"
echo -e "  ${YELLOW}npm run gen-types${NC}        - Regenerate TypeScript types"
echo -e "  ${YELLOW}npm run gen-controllers${NC}  - Regenerate controller scaffolds"
echo -e "  ${YELLOW}npm run validate${NC}         - Run type-check, lint, and format check"
echo ""
echo "Quick tips:"
echo -e "  • Modify ${CYAN}api/openapi.yaml${NC} to update your API spec"
echo -e "  • Run ${CYAN}npm run generate${NC} after changing the spec to update code"
echo -e "  • Implement business logic in ${CYAN}src/controllers/${NC}"
echo -e "  • Edit ${CYAN}config/api-keys.json${NC} to manage API keys"
echo -e "  • Press ${CYAN}Ctrl+C${NC} to stop the server"
echo ""
print_success "Happy coding! 🎉"
echo ""

# Keep the script running and show logs
print_info "Server logs (press Ctrl+C to stop):"
echo -e "${CYAN}───────────────────────────────────────────────${NC}"

# Tail the server output
wait $DEV_SERVER_PID
